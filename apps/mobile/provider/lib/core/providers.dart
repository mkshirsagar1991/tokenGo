import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../features/bookings/qr_scan_screen.dart';

final providerRepositoryProvider = Provider<ProviderRepository>((ref) => ProviderRepository(ref.watch(apiClientProvider)));

/// Registration, locations, services, staff, hours, time off and booking rules.
final setupRepositoryProvider = Provider<ProviderSetupRepository>((ref) => ProviderSetupRepository(ref.watch(apiClientProvider)));

final discoveryRepositoryProvider = Provider<DiscoveryRepository>((ref) => DiscoveryRepository(ref.watch(apiClientProvider)));

/// Where the phone is, ON REQUEST ONLY: the location permission is asked for the first time when this is called (when the
/// owner taps "Use my current location"), never at startup. Overridden in tests.
typedef DeviceLocator = Future<DeviceFix> Function();

sealed class DeviceFix {
  const DeviceFix();
}

class DeviceFound extends DeviceFix {
  const DeviceFound(this.latitude, this.longitude);
  final double latitude;
  final double longitude;
}

class DeviceUnavailable extends DeviceFix {
  const DeviceUnavailable(this.message, {this.canOpenSettings = false});
  final String message;
  final bool canOpenSettings;
}

Future<DeviceFix> locateDevice() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return const DeviceUnavailable('Location is switched off on this phone. Turn it on, or type the coordinates instead.');
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied) {
      return const DeviceUnavailable('Location permission was not granted. You can still type the coordinates.');
    }
    if (permission == LocationPermission.deniedForever) {
      return const DeviceUnavailable(
        'Location permission is blocked for TokenGo Business. Enable it in Settings, or type the coordinates.',
        canOpenSettings: true,
      );
    }
    final pos = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)),
    );
    return DeviceFound(pos.latitude, pos.longitude);
  } catch (_) {
    return const DeviceUnavailable('Could not read the location. Type the coordinates instead.');
  }
}

final deviceLocatorProvider = Provider<DeviceLocator>((ref) => locateDevice);

/// Opens the QR scanner and returns what it read (null = the person backed out). The camera permission is requested by the
/// scanner when it opens, i.e. only after "Scan customer QR" is tapped. Overridden in tests (there is no camera there).
typedef QrScanLauncher = Future<String?> Function(BuildContext context);

final qrScanLauncherProvider = Provider<QrScanLauncher>((ref) => openQrScanner);

/// Whether the location form draws a map preview (tiles come over the network, so tests switch it off).
final mapPreviewEnabledProvider = Provider<bool>((ref) => true);
