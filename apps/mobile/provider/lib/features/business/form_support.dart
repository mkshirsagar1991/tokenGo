import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// The server's validation messages per field (and any general message), kept by a form so each input can show its own.
/// Local checks use the same field names ([FieldProblems]), so a problem found on the phone and one reported by the server
/// land on the same input.
class ServerErrors {
  Map<String, List<String>> _fields = {};
  String? _message;

  bool get isEmpty => _fields.isEmpty && _message == null;

  void clear() {
    _fields = {};
    _message = null;
  }

  /// A refusal (or a network failure) from the API.
  void set(Object error) {
    if (error is ApiException) {
      _fields = {...error.fields};
      _message = error.fields.isEmpty ? error.userMessage : null;
    } else {
      _fields = {};
      _message = errorMessage(error);
    }
  }

  /// Problems found on the phone before sending anything.
  void setLocal(FieldProblems problems) {
    _fields = {
      for (final e in problems.entries) e.key: [e.value],
    };
    _message = null;
  }

  void clearField(String field) => _fields.remove(field);

  String? field(String name) {
    final m = _fields[name];
    return m == null || m.isEmpty ? null : m.join('\n');
  }

  /// What the banner should say: the general message, plus the messages of fields this screen has no input for
  /// (for example `working` on the hours editor), so nothing the server said is lost.
  List<String> banner(Set<String> shownInline) => [
    ?_message,
    for (final e in _fields.entries)
      if (!shownInline.contains(e.key)) ...e.value,
  ];
}

class FormBanner extends StatelessWidget {
  const FormBanner(this.messages, {super.key});

  final List<String> messages;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) return const SizedBox.shrink();
    final s = context.statusColors;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: Gap.md),
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(color: s.dangerContainer, borderRadius: BorderRadius.circular(Corners.md)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, color: s.danger, size: 20),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(messages.join('\n'), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: s.danger)),
          ),
        ],
      ),
    );
  }
}

/// A filled button that shows a spinner and cannot be pressed again while its request is in flight.
class BusyButton extends StatelessWidget {
  const BusyButton({super.key, required this.label, required this.busy, required this.onPressed, this.icon});

  final String label;
  final bool busy;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final child = busy
        ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: Gap.sm)],
              Flexible(child: Text(label)),
            ],
          );
    return FilledButton(onPressed: busy ? null : onPressed, child: child);
  }
}

Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(cancelLabel)),
        FilledButton(
          style: FilledButton.styleFrom(
            minimumSize: const Size(100, 44),
            backgroundColor: destructive ? Theme.of(ctx).colorScheme.error : null,
            foregroundColor: destructive ? Theme.of(ctx).colorScheme.onError : null,
          ),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return ok == true;
}

/// Loading / error-with-retry / data for a provider, keeping the old data on screen while a refresh is in flight.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({super.key, required this.value, required this.onRetry, required this.builder});

  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) builder;

  @override
  Widget build(BuildContext context) => value.when(
    skipLoadingOnReload: true,
    loading: () => const BrandLoader(),
    error: (e, _) => ErrorState(error: e, onRetry: onRetry),
    data: builder,
  );
}

/// A tappable row inside a card, in the style of the Business menu.
class MenuTile extends StatelessWidget {
  const MenuTile({super.key, required this.icon, required this.title, this.subtitle, this.trailing, required this.onTap});

  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(icon, color: Theme.of(context).colorScheme.primary),
    title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
    subtitle: subtitle == null ? null : Text(subtitle!),
    trailing: trailing ?? const Icon(Icons.chevron_right_rounded),
    onTap: onTap,
  );
}

/// "Mon", "Tue" … for ISO weekday numbers.
String weekdayShortName(int isoWeekday) => const ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][isoWeekday - 1];

/// "09:30" → TimeOfDay (a clock reading, with no time zone attached).
TimeOfDay timeOfHhmm(String hhmm) {
  final m = HoursWindow.minutesOf(hhmm);
  return TimeOfDay(hour: (m ~/ 60) % 24, minute: m % 60);
}

/// TimeOfDay → "09:30".
String hhmmOfTime(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// "2026-10-12" from a picked date (the calendar day as picked, never shifted by a time zone).
String isoDateOf(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

DateTime dateOfIso(String iso) {
  final p = iso.split('-').map(int.parse).toList();
  return DateTime(p[0], p[1], p[2]);
}

/// "9:00 AM – 7:00 PM"; an end of 24:00 reads "12:00 AM (midnight)".
String windowLabel(HoursWindow w) => '${formatLocalTime(w.start)} – ${w.end == '24:00' ? 'midnight' : formatLocalTime(w.end)}';
