import AsyncStorage from '@react-native-async-storage/async-storage'

import type { LogEntry } from './types'

export const STORAGE_KEY = 'looming_logger_queue'

/**
 * Persist the pending queue so logs survive an app kill while offline.
 * Failures are swallowed — losing buffered logs must never surface as an app
 * error.
 */
export async function saveQueue(queue: LogEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue))
  } catch {
    // ignored
  }
}

/**
 * Read the persisted queue. Returns [] if nothing is stored or the payload is
 * unreadable.
 *
 * Deliberately does not clear it. The entries are being replayed, not
 * delivered: until a send succeeds they exist only in memory, so a process that
 * dies again before then — a startup crash loop — would lose the previous run's
 * logs for good. The copy is replaced by the next persist, and cleared once a
 * send is accepted.
 */
export async function loadQueue(): Promise<LogEntry[]> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY)
    if (!stored) return []

    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? (parsed as LogEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Drop the persisted copy after a successful send, so a queue that was saved
 * during an outage is not replayed on the next launch.
 */
export async function clearQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignored
  }
}
