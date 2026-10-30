/// Build-time configuration, supplied with `--dart-define`:
///
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
///
/// The default suits the Android emulator talking to an API on the developer machine (10.0.2.2 is the host loopback).
abstract final class AppConfig {
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000/api/v1');

  /// The map is just a tile URL template (switching provider is configuration). The OpenStreetMap default is for development
  /// only: its usage policy forbids heavy production traffic.
  static const mapTileUrl = String.fromEnvironment('MAP_TILE_URL', defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');

  /// Identifies the app to the tile server (required by OSM's policy).
  static const mapUserAgentPackage = 'com.tokengo.tokengo_provider';
}
