# Looming Tech React Native Logging SDK

Remote logging SDK for React Native apps. Sends logs to a self-hosted Loki backend with automatic batching, offline persistence, and device info collection.

Port of [looming-logger-flutter](https://github.com/Looming-Tech/looming-logger-flutter) — same wire format, same API shape.

## Related SDKs

| Platform | Repository |
|----------|------------|
| React Native | [looming-logger-react-native](https://github.com/Looming-Tech/looming-logger-react-native) |
| Flutter | [looming-logger-flutter](https://github.com/Looming-Tech/looming-logger-flutter) |
| Swift (iOS) | [looming-logger-swift](https://github.com/Looming-Tech/looming-logger-swift) |

## Features

- Automatic device info collection (platform, OS version, model, device ID, etc.)
- Batched log sending with configurable flush interval (default: 30 seconds)
- Offline persistence — logs are saved to disk on network failure and retried
- Immediate flush for error-level logs
- Configurable queue size, flush interval, and timeouts
- Written in TypeScript, ships with type definitions

## Installation

```bash
yarn add github:Looming-Tech/looming-logger-react-native
```

Then install the peer dependencies in your app:

```bash
yarn add react-native-device-info @react-native-async-storage/async-storage
```

Both are native modules:

- **Bare React Native** — run `cd ios && pod install`.
- **Expo** — run `npx expo prebuild` (they are not supported in Expo Go).

## Peer Dependencies

| Package | Version | Used for |
|---------|---------|----------|
| `react-native` | >= 0.71 | `Platform`, `fetch` |
| `react-native-device-info` | >= 10 | Device and app metadata |
| `@react-native-async-storage/async-storage` | >= 1.19 | Offline queue persistence |

## Usage

### Initialize

Call `init()` once at app startup, before you log anything:

```ts
import { LoomingLogger } from 'looming-logger-react-native'

await LoomingLogger.init({
  baseUrl: 'https://logs.yourdomain.com',
  apiKey: 'your-api-key',
  appId: 'your-app-id',
})
```

In an Expo Router app, do this in the root layout:

```tsx
// app/_layout.tsx
useEffect(() => {
  LoomingLogger.init({
    baseUrl: process.env.EXPO_PUBLIC_LOG_URL!,
    apiKey: process.env.EXPO_PUBLIC_LOG_KEY!,
    appId: 'my-app',
  })

  return () => {
    void LoomingLogger.dispose()
  }
}, [])
```

Calls made before `init()` resolves are dropped, not queued — same as the Flutter SDK.

### Logging

```ts
// Info level
LoomingLogger.info('User logged in', { userId: '123' })

// Debug level
LoomingLogger.debug('Fetching data from API')

// Warning level
LoomingLogger.warn('Slow network detected', { latency: 2000 })

// Error level (flushes immediately)
LoomingLogger.error('Payment failed', {
  orderId: '456',
  errorCode: 'TIMEOUT',
})
```

All logging methods are synchronous and fire-and-forget — they never block or throw.

### Configuration

```ts
await LoomingLogger.init({
  baseUrl: 'https://logs.yourdomain.com',
  apiKey: 'your-api-key',
  appId: 'your-app-id',
  config: {
    maxQueueSize: 200,          // Max logs to queue (default: 100)
    flushIntervalSeconds: 60,   // Flush interval (default: 30)
    httpTimeoutSeconds: 15,     // HTTP timeout (default: 10)
    printToConsole: false,      // Disable console output (default: true)
  },
})
```

`printToConsole` only affects dev builds — nothing is printed when `__DEV__` is false.

### Manual Flush

```ts
await LoomingLogger.flush()
```

### Cleanup

Optional — flushes remaining logs and stops the timer:

```ts
await LoomingLogger.dispose()
```

### Checking state

```ts
if (LoomingLogger.isInitialized) {
  // ...
}
```

## Device Info Collected

**All platforms:**
- App name, version, build number, package ID
- Platform (`ios` / `android`)
- OS version
- Device ID (`getUniqueId`)
- Model
- Whether it is a physical device

**Android-specific:**
- Manufacturer, brand, device, product
- SDK level, security patch
- Hardware, display, fingerprint
- Supported ABIs

**iOS-specific:**
- Device name, machine ID (e.g. `iPhone14,2`), system name

Any field the native module cannot supply is sent as `null` rather than failing initialisation.

## Log Format

Logs are POSTed to `{baseUrl}/api/logs/batch` with an `X-API-Key` header:

```json
{
  "logs": [
    {
      "app_id": "your-app-id",
      "level": "info",
      "message": "User logged in",
      "timestamp": "2025-01-09T10:30:00.000Z",
      "device_id": "abc123",
      "platform": "android",
      "os_version": "14",
      "model": "Pixel 8",
      "app_version": "2.0.0",
      "build_number": "42",
      "metadata": { "userId": "123" }
    }
  ]
}
```

## Delivery Semantics

- **Success (201)** — batch is sent, the persisted copy is cleared.
- **4xx** — permanent rejection. The batch is dropped; re-queueing would loop forever.
- **5xx / network error / timeout** — the batch is put back at the front of the queue and persisted to disk. It is retried on the next flush, and survives an app restart.
- **Entries older than 50 minutes are dropped** before every send. Loki rejects samples older than 1h with "entry too far behind", and one bad entry fails the whole batch — without this cutoff a single outage poisons the queue permanently.
- **Queue overflow** — when the queue exceeds `maxQueueSize`, the *oldest* entries are dropped.

## Differences from the Flutter SDK

The API surface and wire format are identical. Three behavioural changes, all deliberate:

1. **The persisted queue is cleared after a successful send.** In the Flutter SDK the disk copy is only ever written on failure and only removed at load, so a batch that failed once and then succeeded is still on disk and gets replayed on the next launch — duplicate logs. This port clears it on success.
2. **Concurrent flushes are serialised.** An `error()` call can trigger a flush while the interval timer's flush is still in flight; in the Flutter SDK both would read the queue and send overlapping batches. This port returns the in-flight promise instead.
3. **`init()` is safe to call twice.** The previous instance is disposed first, so no orphaned flush timer is left running. The Flutter SDK leaks the old timer.

Two Android fields have no `react-native-device-info` equivalent and are not sent: `board`, and iOS `localized_model`.

## Development

```bash
yarn install
yarn typecheck
yarn test
yarn build
```

`lib/` is built by the `prepare` script, so installing straight from GitHub works without committing build output.

## Requirements

- React Native >= 0.71
- TypeScript >= 5.0 (consumers only need this for types)
