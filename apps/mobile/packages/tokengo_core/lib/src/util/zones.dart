import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// Wall-clock arithmetic in a LOCATION's IANA time zone ("Asia/Kolkata"), never the phone's.
///
/// Most times in the apps are already local strings from the server ("2026-10-08T09:00"). The exception is where the API
/// speaks in INSTANTS (a walk-in block is `start_at`/`end_at` in UTC): to build one from "10 Oct, 9:00 AM at the salon" the
/// salon's zone is needed, and `DateTime(...)` would silently use the phone's.
bool _ready = false;

tz.Location _location(String zone) {
  if (!_ready) {
    tzdata.initializeTimeZones();
    _ready = true;
  }
  return tz.getLocation(zone);
}

/// True for a time zone the database knows ("Asia/Kolkata"); false for typos, empty strings and abbreviations ("IST").
bool isValidTimeZone(String zone) {
  if (zone.trim().isEmpty || zone.length > 64) return false;
  try {
    _location(zone);
    return true;
  } catch (_) {
    return false;
  }
}

/// The calendar date "now" is in [zone], as "YYYY-MM-DD".
String todayIn(String zone, {DateTime? now}) {
  final t = tz.TZDateTime.from(now ?? DateTime.now(), _location(zone));
  return _iso(t.year, t.month, t.day);
}

/// The instant (UTC) at which the wall clock in [zone] reads [localDate] ("YYYY-MM-DD") [hhmm] ("09:30").
DateTime instantAt(String zone, String localDate, String hhmm) {
  final d = localDate.split('-').map(int.parse).toList();
  final t = hhmm.split(':').map(int.parse).toList();
  return tz.TZDateTime(_location(zone), d[0], d[1], d[2], t[0], t[1]).toUtc();
}

/// What the wall clock in [zone] reads at [instant]: date "YYYY-MM-DD" and time "HH:MM".
({String date, String time}) localParts(String zone, DateTime instant) {
  final t = tz.TZDateTime.from(instant, _location(zone));
  return (date: _iso(t.year, t.month, t.day), time: '${_two(t.hour)}:${_two(t.minute)}');
}

String _iso(int y, int m, int d) => '${y.toString().padLeft(4, '0')}-${_two(m)}-${_two(d)}';
String _two(int n) => n.toString().padLeft(2, '0');
