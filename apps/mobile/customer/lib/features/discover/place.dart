import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where the customer is searching around. Browsing works with a manually chosen place; the phone's location is used
/// ONLY when the person asks for it (requirements §5: never demand location permission at startup).
@immutable
class PlaceChoice {
  const PlaceChoice({required this.label, required this.lat, required this.lng, this.fromDevice = false});

  final String label;
  final double lat;
  final double lng;
  final bool fromDevice;

  static const pune = PlaceChoice(label: 'Pune', lat: 18.5204, lng: 73.8567);
  static const mumbai = PlaceChoice(label: 'Mumbai', lat: 19.0760, lng: 72.8777);
  static const bengaluru = PlaceChoice(label: 'Bengaluru', lat: 12.9716, lng: 77.5946);
  static const delhi = PlaceChoice(label: 'Delhi', lat: 28.6139, lng: 77.2090);
  static const hyderabad = PlaceChoice(label: 'Hyderabad', lat: 17.3850, lng: 78.4867);
  static const chennai = PlaceChoice(label: 'Chennai', lat: 13.0827, lng: 80.2707);

  static const presets = [pune, mumbai, bengaluru, delhi, hyderabad, chennai];

  @override
  bool operator ==(Object other) => other is PlaceChoice && other.lat == lat && other.lng == lng && other.label == label;

  @override
  int get hashCode => Object.hash(label, lat, lng);
}

class PlaceNotifier extends Notifier<PlaceChoice> {
  static const _kLabel = 'place.label';
  static const _kLat = 'place.lat';
  static const _kLng = 'place.lng';
  static const _kDevice = 'place.device';

  @override
  PlaceChoice build() {
    Future.microtask(_restore);
    return PlaceChoice.pune;
  }

  Future<void> _restore() async {
    try {
      final p = await SharedPreferences.getInstance();
      final lat = p.getDouble(_kLat);
      final lng = p.getDouble(_kLng);
      final label = p.getString(_kLabel);
      if (lat != null && lng != null && label != null) {
        state = PlaceChoice(label: label, lat: lat, lng: lng, fromDevice: p.getBool(_kDevice) ?? false);
      }
    } catch (_) {
      // A broken preference store must never stop the app: keep the default place.
    }
  }

  Future<void> select(PlaceChoice place) async {
    state = place;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_kLabel, place.label);
      await p.setDouble(_kLat, place.lat);
      await p.setDouble(_kLng, place.lng);
      await p.setBool(_kDevice, place.fromDevice);
    } catch (_) {
      // Not persisting is harmless.
    }
  }
}

final placeProvider = NotifierProvider<PlaceNotifier, PlaceChoice>(PlaceNotifier.new);

/// The outcome of asking the phone where it is.
sealed class DeviceLocationResult {
  const DeviceLocationResult();
}

class DeviceLocationFound extends DeviceLocationResult {
  const DeviceLocationFound(this.place);
  final PlaceChoice place;
}

class DeviceLocationUnavailable extends DeviceLocationResult {
  const DeviceLocationUnavailable(this.message, {this.canOpenSettings = false});
  final String message;
  final bool canOpenSettings;
}

/// Asks for the location permission (only when called) and reads the current position once.
Future<DeviceLocationResult> locateDevice() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return const DeviceLocationUnavailable('Location is switched off on this phone. Turn it on, or pick a city instead.');
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied) {
      return const DeviceLocationUnavailable('Location permission was not granted. You can still pick a city.');
    }
    if (permission == LocationPermission.deniedForever) {
      return const DeviceLocationUnavailable(
        'Location permission is blocked for TokenGo. Enable it in Settings, or pick a city.',
        canOpenSettings: true,
      );
    }
    final pos = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 12)),
    );
    return DeviceLocationFound(PlaceChoice(label: 'Current location', lat: pos.latitude, lng: pos.longitude, fromDevice: true));
  } catch (_) {
    return const DeviceLocationUnavailable('Could not read your location. Pick a city instead.');
  }
}
