import { Platform } from 'react-native'
import DeviceInfo from 'react-native-device-info'

import type { DeviceInfo as DeviceInfoMap } from './types'

/**
 * Resolve a device-info getter, falling back to `null` if the platform or the
 * native module does not support it. A missing field must never take down
 * logger initialisation.
 */
async function safe<T>(fn: () => T | Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

/**
 * Collect app + device metadata once at startup. Mirrors the field names used
 * by the Flutter SDK so both platforms land in the same Loki labels.
 */
export async function collectDeviceInfo(): Promise<DeviceInfoMap> {
  const [appName, packageId, appVersion, buildNumber, uniqueId, systemVersion, model, isEmulator] =
    await Promise.all([
      safe(() => DeviceInfo.getApplicationName()),
      safe(() => DeviceInfo.getBundleId()),
      safe(() => DeviceInfo.getVersion()),
      safe(() => DeviceInfo.getBuildNumber()),
      safe(() => DeviceInfo.getUniqueId()),
      safe(() => DeviceInfo.getSystemVersion()),
      safe(() => DeviceInfo.getModel()),
      safe(() => DeviceInfo.isEmulator()),
    ])

  const info: DeviceInfoMap = {
    app_name: appName,
    package_id: packageId,
    app_version: appVersion,
    build_number: buildNumber,
    device_id: uniqueId ?? 'unknown',
    platform: Platform.OS,
    os_version: systemVersion,
    model,
    is_physical_device: isEmulator === null ? null : !isEmulator,
  }

  if (Platform.OS === 'android') {
    const [
      apiLevel,
      securityPatch,
      manufacturer,
      brand,
      device,
      product,
      hardware,
      display,
      fingerprint,
      supportedAbis,
    ] = await Promise.all([
      safe(() => DeviceInfo.getApiLevel()),
      safe(() => DeviceInfo.getSecurityPatch()),
      safe(() => DeviceInfo.getManufacturer()),
      safe(() => DeviceInfo.getBrand()),
      safe(() => DeviceInfo.getDevice()),
      safe(() => DeviceInfo.getProduct()),
      safe(() => DeviceInfo.getHardware()),
      safe(() => DeviceInfo.getDisplay()),
      safe(() => DeviceInfo.getFingerprint()),
      safe(() => DeviceInfo.supportedAbis()),
    ])

    Object.assign(info, {
      sdk_int: apiLevel,
      security_patch: securityPatch ?? '',
      manufacturer,
      brand,
      device,
      product,
      hardware,
      display,
      fingerprint,
      supported_abis: supportedAbis,
    })
  } else if (Platform.OS === 'ios') {
    const [deviceName, machine, systemName] = await Promise.all([
      safe(() => DeviceInfo.getDeviceName()),
      // getDeviceId() returns the hardware string, e.g. "iPhone14,2" —
      // the equivalent of Flutter's `utsname.machine`.
      safe(() => DeviceInfo.getDeviceId()),
      safe(() => DeviceInfo.getSystemName()),
    ])

    Object.assign(info, {
      device_name: deviceName,
      machine,
      system_name: systemName,
    })
  }

  return info
}
