/**
 * Arbitrary structured data attached to a log entry.
 */
export type LogMetadata = Record<string, unknown>

/**
 * Severity levels, mirroring the Flutter SDK.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Configuration options for the logger.
 */
export interface LoggerConfig {
  /** Maximum number of logs to queue before the oldest are dropped. Default: 100. */
  maxQueueSize?: number

  /** Interval in seconds between automatic flushes. Default: 30. */
  flushIntervalSeconds?: number

  /** HTTP timeout in seconds for sending logs. Default: 10. */
  httpTimeoutSeconds?: number

  /** Whether to print logs to the console in dev builds (`__DEV__`). Default: true. */
  printToConsole?: boolean
}

/**
 * Options accepted by {@link LoomingLogger.init}.
 */
export interface LoomingLoggerOptions {
  /** Base URL of the logging server, e.g. `https://logs.example.com`. */
  baseUrl: string

  /** API key sent as the `X-API-Key` header. */
  apiKey: string

  /** Identifier for this app, e.g. `my-app-ios`. */
  appId: string

  /** Optional configuration overrides. */
  config?: LoggerConfig
}

/**
 * Device and app metadata collected once at init and merged into every entry.
 */
export type DeviceInfo = Record<string, unknown>

/**
 * A single queued log entry, in the exact shape sent to `/api/logs/batch`.
 */
export interface LogEntry extends DeviceInfo {
  app_id: string
  level: LogLevel
  message: string
  /** ISO-8601 UTC, e.g. `2025-01-09T10:30:00.000Z`. */
  timestamp: string
  metadata?: LogMetadata
}

/** Resolved config with every field present. */
export type ResolvedLoggerConfig = Required<LoggerConfig>

export const DEFAULT_CONFIG: ResolvedLoggerConfig = {
  maxQueueSize: 100,
  flushIntervalSeconds: 30,
  httpTimeoutSeconds: 10,
  printToConsole: true,
}
