import { collectDeviceInfo } from './deviceInfo'
import { clearQueue, loadQueue, saveQueue } from './storage'
import {
  DEFAULT_CONFIG,
  type DeviceInfo,
  type LogEntry,
  type LogLevel,
  type LogMetadata,
  type LoomingLoggerOptions,
  type ResolvedLoggerConfig,
} from './types'

declare const __DEV__: boolean | undefined

/**
 * Loki rejects samples older than 1h with "entry too far behind", and a single
 * rejected entry fails the whole batch. Without this cutoff a one-time flush
 * failure poisons the queue forever: persisted entries age past the threshold,
 * every subsequent flush gets a 400, and the batch is re-queued to the front.
 */
const MAX_ENTRY_AGE_MS = 50 * 60 * 1000

const LOG_PATH = '/api/logs/batch'

/**
 * Remote logging service for sending logs to a self-hosted Loki backend.
 *
 * Features:
 * - Automatic device info collection (platform, OS version, model, etc.)
 * - Batched log sending with a configurable flush interval
 * - Offline persistence via AsyncStorage
 * - Immediate flush for error-level logs
 *
 * Usage:
 * ```ts
 * await LoomingLogger.init({
 *   baseUrl: 'https://logs.example.com',
 *   apiKey: 'your-api-key',
 *   appId: 'your-app-id',
 * })
 *
 * LoomingLogger.info('User logged in', { userId: '123' })
 * LoomingLogger.error('Payment failed', { orderId: '456' })
 * ```
 */
export class LoomingLogger {
  private static _instance: LoomingLogger | null = null

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly appId: string
  private readonly config: ResolvedLoggerConfig

  private deviceInfo: DeviceInfo = {}
  private queue: LogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private initialized = false
  /** Guards against the interval and an error-triggered flush overlapping. */
  private flushing: Promise<void> | null = null

  private constructor(options: LoomingLoggerOptions) {
    // Trailing slash would produce `//api/logs/batch`.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.appId = options.appId
    this.config = { ...DEFAULT_CONFIG, ...options.config }
  }

  /**
   * Initialize the logger. Call once at app startup.
   *
   * Safe to call more than once — a second call replaces the instance and
   * disposes the previous one, so no orphaned flush timer is left running.
   */
  public static async init(options: LoomingLoggerOptions): Promise<void> {
    if (LoomingLogger._instance) {
      await LoomingLogger._instance.disposeInstance()
    }

    const instance = new LoomingLogger(options)
    LoomingLogger._instance = instance
    await instance.initialize()
  }

  /** Whether {@link init} has completed. */
  public static get isInitialized(): boolean {
    return LoomingLogger._instance?.initialized ?? false
  }

  private async initialize(): Promise<void> {
    this.deviceInfo = await collectDeviceInfo()
    this.queue = this.dropExpired(await loadQueue())
    this.startFlushTimer()
    this.initialized = true
  }

  // ============ Public Logging Methods ============

  /** Log a debug message. */
  public static debug(message: string, metadata?: LogMetadata): void {
    LoomingLogger._instance?.log('debug', message, metadata)
  }

  /** Log an info message. */
  public static info(message: string, metadata?: LogMetadata): void {
    LoomingLogger._instance?.log('info', message, metadata)
  }

  /** Log a warning message. */
  public static warn(message: string, metadata?: LogMetadata): void {
    LoomingLogger._instance?.log('warn', message, metadata)
  }

  /** Log an error message. Triggers an immediate flush. */
  public static error(message: string, metadata?: LogMetadata): void {
    LoomingLogger._instance?.log('error', message, metadata)
  }

  private log(level: LogLevel, message: string, metadata?: LogMetadata): void {
    if (!this.initialized) return

    if (typeof __DEV__ !== 'undefined' && __DEV__ && this.config.printToConsole) {
      // eslint-disable-next-line no-console
      console.log(`[${level}] ${message}`, metadata ?? '')
    }

    const entry: LogEntry = {
      app_id: this.appId,
      ...this.deviceInfo,
      level,
      message,
      timestamp: new Date().toISOString(),
    }

    if (metadata) {
      entry.metadata = metadata
    }

    this.queue.push(entry)

    // Trim oldest first so the newest maxQueueSize entries survive.
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue.splice(0, this.queue.length - this.config.maxQueueSize)
    }

    if (level === 'error') {
      // Fire-and-forget: logging must never block the caller.
      void this.flushInstance()
    }
  }

  // ============ Queue Management ============

  private startFlushTimer(): void {
    this.stopFlushTimer()
    this.flushTimer = setInterval(() => {
      void this.flushInstance()
    }, this.config.flushIntervalSeconds * 1000)
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  private dropExpired(entries: LogEntry[]): LogEntry[] {
    const cutoff = new Date(Date.now() - MAX_ENTRY_AGE_MS).toISOString()
    return entries.filter((entry) => !entry.timestamp || entry.timestamp >= cutoff)
  }

  /** Manually flush all pending logs. */
  public static async flush(): Promise<void> {
    await LoomingLogger._instance?.flushInstance()
  }

  private flushInstance(): Promise<void> {
    // Serialise flushes: an error log can fire one while the interval's is
    // still in flight, which would send the same batch twice.
    if (this.flushing) return this.flushing

    this.flushing = this.doFlush().finally(() => {
      this.flushing = null
    })

    return this.flushing
  }

  private async doFlush(): Promise<void> {
    if (this.queue.length === 0) return

    this.queue = this.dropExpired(this.queue)
    if (this.queue.length === 0) return

    const batch = this.queue
    this.queue = []

    try {
      const response = await this.post(batch)

      if (response.status >= 400 && response.status < 500) {
        // 4xx is a permanent rejection — re-queueing would loop forever.
        // Drop the batch, and drop any persisted copy of it too.
        await clearQueue()
        return
      }

      if (response.status !== 201) {
        // 5xx / transient — retry on next flush.
        this.queue.unshift(...batch)
        await saveQueue(this.queue)
        return
      }

      // Sent. Clear the persisted copy so an earlier outage's queue is not
      // replayed on next launch.
      await clearQueue()
    } catch {
      // Network error — retry on next flush.
      this.queue.unshift(...batch)
      await saveQueue(this.queue)
    }
  }

  private async post(batch: LogEntry[]): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutSeconds * 1000)

    try {
      return await fetch(`${this.baseUrl}${LOG_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({ logs: batch }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  // ============ Teardown ============

  /**
   * Flush pending logs and stop the timer.
   * Call on app termination if needed.
   */
  public static async dispose(): Promise<void> {
    await LoomingLogger._instance?.disposeInstance()
    LoomingLogger._instance = null
  }

  private async disposeInstance(): Promise<void> {
    this.stopFlushTimer()
    this.initialized = false
    await this.flushInstance()

    // Anything still queued failed to send — keep it for the next launch.
    if (this.queue.length > 0) {
      await saveQueue(this.queue)
    }
  }
}
