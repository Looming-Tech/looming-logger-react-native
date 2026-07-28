const mockStore = new Map<string, string>()

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore.set(k, v)
    }),
    removeItem: jest.fn(async (k: string) => {
      mockStore.delete(k)
    }),
  },
}))

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getApplicationName: async () => 'TestApp',
    getBundleId: async () => 'com.test.app',
    getVersion: async () => '2.0.0',
    getBuildNumber: async () => '42',
    getUniqueId: async () => 'device-abc',
    getSystemVersion: async () => '17.2',
    getModel: async () => 'iPhone',
    isEmulator: async () => false,
    getDeviceName: async () => 'Test iPhone',
    getDeviceId: async () => 'iPhone14,2',
    getSystemName: async () => 'iOS',
  },
}))

import { LoomingLogger } from '../src'
import { STORAGE_KEY } from '../src/storage'
import type { LogEntry } from '../src/types'

const OPTIONS = {
  baseUrl: 'https://logs.example.com/',
  apiKey: 'secret-key',
  appId: 'test-app',
  config: { printToConsole: false, flushIntervalSeconds: 30 },
}

const respond = (status: number) => ({ status }) as Response

/** Read the JSON body of the Nth fetch call. */
const bodyOf = (call: number): { logs: LogEntry[] } =>
  JSON.parse((global.fetch as jest.Mock).mock.calls[call][1].body)

describe('LoomingLogger', () => {
  beforeEach(async () => {
    mockStore.clear()
    jest.useFakeTimers()
    global.fetch = jest.fn(async () => respond(201)) as unknown as typeof fetch
  })

  afterEach(async () => {
    await LoomingLogger.dispose()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('does not send anything before init', () => {
    LoomingLogger.info('dropped')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(LoomingLogger.isInitialized).toBe(false)
  })

  it('reports initialized after init', async () => {
    await LoomingLogger.init(OPTIONS)
    expect(LoomingLogger.isInitialized).toBe(true)
  })

  it('batches queued logs into one request on flush', async () => {
    await LoomingLogger.init(OPTIONS)

    LoomingLogger.info('one', { a: 1 })
    LoomingLogger.debug('two')
    LoomingLogger.warn('three')
    expect(global.fetch).not.toHaveBeenCalled()

    await LoomingLogger.flush()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://logs.example.com/api/logs/batch')
    expect(init.method).toBe('POST')
    expect(init.headers['X-API-Key']).toBe('secret-key')
    expect(bodyOf(0).logs.map((l) => l.message)).toEqual(['one', 'two', 'three'])
  })

  it('stamps each entry with app id, device info and metadata', async () => {
    await LoomingLogger.init(OPTIONS)
    LoomingLogger.info('User logged in', { userId: '123' })
    await LoomingLogger.flush()

    const entry = bodyOf(0).logs[0]!
    expect(entry).toMatchObject({
      app_id: 'test-app',
      level: 'info',
      message: 'User logged in',
      platform: 'ios',
      device_id: 'device-abc',
      app_version: '2.0.0',
      build_number: '42',
      machine: 'iPhone14,2',
      is_physical_device: true,
      metadata: { userId: '123' },
    })
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  it('omits the metadata key when none is given', async () => {
    await LoomingLogger.init(OPTIONS)
    LoomingLogger.info('no metadata')
    await LoomingLogger.flush()

    expect(bodyOf(0).logs[0]).not.toHaveProperty('metadata')
  })

  it('flushes immediately on an error log', async () => {
    await LoomingLogger.init(OPTIONS)

    LoomingLogger.info('buffered')
    LoomingLogger.error('Payment failed', { orderId: '456' })
    await LoomingLogger.flush()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(bodyOf(0).logs.map((l) => l.level)).toEqual(['info', 'error'])
  })

  it('flushes on the configured interval', async () => {
    await LoomingLogger.init(OPTIONS)
    LoomingLogger.info('tick')

    jest.advanceTimersByTime(30_000)
    await Promise.resolve()

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when the queue is empty', async () => {
    await LoomingLogger.init(OPTIONS)
    await LoomingLogger.flush()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('drops the oldest entries beyond maxQueueSize', async () => {
    await LoomingLogger.init({ ...OPTIONS, config: { ...OPTIONS.config, maxQueueSize: 3 } })

    for (let i = 0; i < 6; i++) LoomingLogger.info(`msg-${i}`)
    await LoomingLogger.flush()

    expect(bodyOf(0).logs.map((l) => l.message)).toEqual(['msg-3', 'msg-4', 'msg-5'])
  })

  describe('failure handling', () => {
    it('drops the batch on 4xx without retrying', async () => {
      global.fetch = jest.fn(async () => respond(400)) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)

      LoomingLogger.info('rejected')
      await LoomingLogger.flush()
      await LoomingLogger.flush()

      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(mockStore.get(STORAGE_KEY)).toBeUndefined()
    })

    it('re-queues and persists on 5xx, then resends', async () => {
      global.fetch = jest.fn(async () => respond(503)) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)

      LoomingLogger.info('transient')
      await LoomingLogger.flush()

      const persisted = JSON.parse(mockStore.get(STORAGE_KEY)!) as LogEntry[]
      expect(persisted.map((l) => l.message)).toEqual(['transient'])

      global.fetch = jest.fn(async () => respond(201)) as unknown as typeof fetch
      await LoomingLogger.flush()
      expect(bodyOf(0).logs.map((l) => l.message)).toEqual(['transient'])
    })

    it('re-queues and persists on a network error', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)

      LoomingLogger.info('offline entry')
      await LoomingLogger.flush()

      const persisted = JSON.parse(mockStore.get(STORAGE_KEY)!) as LogEntry[]
      expect(persisted.map((l) => l.message)).toEqual(['offline entry'])
    })

    it('preserves order when a re-queued batch is followed by new logs', async () => {
      global.fetch = jest.fn(async () => respond(503)) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)

      LoomingLogger.info('first')
      await LoomingLogger.flush()

      global.fetch = jest.fn(async () => respond(201)) as unknown as typeof fetch
      LoomingLogger.info('second')
      await LoomingLogger.flush()

      expect(bodyOf(0).logs.map((l) => l.message)).toEqual(['first', 'second'])
    })

    it('clears the persisted copy after a successful send', async () => {
      global.fetch = jest.fn(async () => respond(503)) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)
      LoomingLogger.info('will succeed later')
      await LoomingLogger.flush()
      expect(mockStore.has(STORAGE_KEY)).toBe(true)

      global.fetch = jest.fn(async () => respond(201)) as unknown as typeof fetch
      await LoomingLogger.flush()

      expect(mockStore.has(STORAGE_KEY)).toBe(false)
    })
  })

  describe('50-minute Loki cutoff', () => {
    const stale = (minutesAgo: number, message: string): LogEntry =>
      ({
        app_id: 'test-app',
        level: 'info',
        message,
        timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      }) as LogEntry

    it('drops persisted entries older than 50 minutes on load', async () => {
      mockStore.set(STORAGE_KEY, JSON.stringify([stale(60, 'too old'), stale(10, 'recent')]))

      await LoomingLogger.init(OPTIONS)
      await LoomingLogger.flush()

      expect(bodyOf(0).logs.map((l) => l.message)).toEqual(['recent'])
    })

    it('drops entries that aged past the cutoff while queued', async () => {
      await LoomingLogger.init(OPTIONS)
      LoomingLogger.info('will expire')

      jest.setSystemTime(Date.now() + 51 * 60_000)
      await LoomingLogger.flush()

      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle', () => {
    it('flushes on dispose', async () => {
      await LoomingLogger.init(OPTIONS)
      LoomingLogger.info('final')

      await LoomingLogger.dispose()

      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(LoomingLogger.isInitialized).toBe(false)
    })

    it('stops the flush timer on dispose', async () => {
      await LoomingLogger.init(OPTIONS)
      await LoomingLogger.dispose()
      ;(global.fetch as jest.Mock).mockClear()

      jest.advanceTimersByTime(120_000)
      await Promise.resolve()

      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('persists anything still unsent on dispose', async () => {
      global.fetch = jest.fn(async () => respond(503)) as unknown as typeof fetch
      await LoomingLogger.init(OPTIONS)
      LoomingLogger.info('unsent')

      await LoomingLogger.dispose()

      const persisted = JSON.parse(mockStore.get(STORAGE_KEY)!) as LogEntry[]
      expect(persisted.map((l) => l.message)).toEqual(['unsent'])
    })

    it('does not leave an orphaned timer when init is called twice', async () => {
      await LoomingLogger.init(OPTIONS)
      await LoomingLogger.init(OPTIONS)
      ;(global.fetch as jest.Mock).mockClear()

      LoomingLogger.info('once')
      jest.advanceTimersByTime(30_000)
      await Promise.resolve()

      expect(global.fetch).toHaveBeenCalledTimes(1)
    })
  })
})
