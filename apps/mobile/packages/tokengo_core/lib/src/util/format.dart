import 'package:intl/intl.dart';

/// Formatting for dates and times the SERVER already expressed in the LOCATION's wall-clock ("2026-10-08T09:00").
///
/// These deliberately do NOT convert time zones: a person booking a salon in Pune wants "9:00 AM" whatever zone their
/// phone is in. Convert only instants (UTC) — and only when there is no local string to show.

/// "2026-10-08" -> "Thu, 8 Oct".
String formatLocalDate(String isoDate, {DateTime? today}) {
  final d = _parseDate(isoDate);
  final now = today ?? DateTime.now();
  final t = DateTime(now.year, now.month, now.day);
  final diff = d.difference(t).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Tomorrow';
  return DateFormat('EEE, d MMM').format(d);
}

/// "2026-10-08" -> "Thursday, 8 October 2026".
String formatLocalDateLong(String isoDate) => DateFormat('EEEE, d MMMM y').format(_parseDate(isoDate));

/// "09:00" -> "9:00 AM", "17:30" -> "5:30 PM".
String formatLocalTime(String hhmm) {
  final parts = hhmm.split(':');
  final h = int.parse(parts[0]);
  final m = int.parse(parts[1]);
  return DateFormat('h:mm a').format(DateTime(2000, 1, 1, h, m));
}

/// "2026-10-08T09:00" -> "Thu, 8 Oct · 9:00 AM".
String formatLocalDateTime(String localIso, {DateTime? today}) =>
    '${formatLocalDate(localIso.substring(0, 10), today: today)} · ${formatLocalTime(localIso.substring(11, 16))}';

/// "2026-10-08" -> "8".
String dayOfMonth(String isoDate) => '${_parseDate(isoDate).day}';

/// "2026-10-08" -> "Thu".
String weekdayShort(String isoDate) => DateFormat('EEE').format(_parseDate(isoDate));

/// "2026-10-08" -> "Oct".
String monthShort(String isoDate) => DateFormat('MMM').format(_parseDate(isoDate));

/// The wall-clock date today as "YYYY-MM-DD" (used to ask for availability starting today).
String todayIso([DateTime? now]) {
  final n = now ?? DateTime.now();
  return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

/// "5 min", "1 h 30 min".
String formatDuration(int minutes) {
  if (minutes < 60) return '$minutes min';
  final h = minutes ~/ 60;
  final m = minutes % 60;
  return m == 0 ? '$h h' : '$h h $m min';
}

/// How long until [target], for countdowns ("in 12 min", "in 2 h", "now").
String formatCountdown(DateTime target, {DateTime? now}) {
  final diff = target.difference(now ?? DateTime.now());
  if (diff.isNegative || diff.inSeconds < 30) return 'now';
  if (diff.inMinutes < 60) return 'in ${diff.inMinutes.clamp(1, 59)} min';
  if (diff.inHours < 48) return 'in ${diff.inHours} h';
  return 'in ${diff.inDays} days';
}

/// "Mon" for ISO weekday 1 … "Sun" for 7.
String weekdayName(int isoWeekday) => const ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoWeekday - 1];

DateTime _parseDate(String isoDate) {
  final p = isoDate.split('-').map(int.parse).toList();
  return DateTime(p[0], p[1], p[2]);
}
