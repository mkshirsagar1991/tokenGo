/// Small, strict accessors for decoded JSON. A missing or mistyped REQUIRED field throws a [FormatException] naming the
/// key, so a change in the API contract fails loudly in one place (and is reported as a bad response), instead of
/// surfacing later as a mysterious null on some screen.
extension JsonMap on Map<String, dynamic> {
  String s(String key) {
    final v = this[key];
    if (v is String) return v;
    throw FormatException('"$key" must be a string, got ${v.runtimeType}');
  }

  String? sn(String key) {
    final v = this[key];
    if (v == null) return null;
    if (v is String) return v;
    throw FormatException('"$key" must be a string or null, got ${v.runtimeType}');
  }

  int i(String key) {
    final v = this[key];
    if (v is int) return v;
    if (v is num && v == v.truncate()) return v.toInt();
    throw FormatException('"$key" must be an integer, got ${v.runtimeType}');
  }

  int? inn(String key) {
    final v = this[key];
    return v == null ? null : i(key);
  }

  double? dn(String key) {
    final v = this[key];
    if (v == null) return null;
    if (v is num) return v.toDouble();
    throw FormatException('"$key" must be a number or null, got ${v.runtimeType}');
  }

  double d(String key) => dn(key) ?? (throw FormatException('"$key" is required'));

  bool b(String key, {bool fallback = false}) {
    final v = this[key];
    return v is bool ? v : fallback;
  }

  Map<String, dynamic> m(String key) {
    final v = this[key];
    if (v is Map<String, dynamic>) return v;
    throw FormatException('"$key" must be an object, got ${v.runtimeType}');
  }

  Map<String, dynamic>? mn(String key) {
    final v = this[key];
    if (v == null) return null;
    if (v is Map<String, dynamic>) return v;
    throw FormatException('"$key" must be an object or null, got ${v.runtimeType}');
  }

  List<Map<String, dynamic>> l(String key) {
    final v = this[key];
    if (v == null) return const [];
    if (v is List) return v.whereType<Map<String, dynamic>>().toList();
    throw FormatException('"$key" must be a list, got ${v.runtimeType}');
  }

  List<String> ls(String key) {
    final v = this[key];
    if (v == null) return const [];
    if (v is List) return v.map((e) => '$e').toList();
    throw FormatException('"$key" must be a list, got ${v.runtimeType}');
  }

  DateTime dt(String key) => DateTime.parse(s(key));
  DateTime? dtn(String key) {
    final v = sn(key);
    return v == null ? null : DateTime.parse(v);
  }
}
