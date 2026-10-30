import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../push/push_service.dart';
import '../state/session_providers.dart';

/// Makes push notifications work for the whole app. Put it around the app's pages (MaterialApp.builder).
///
///  * Once someone is signed in it gets push ready and sends this phone's push address to the server.
///  * A notification that arrives while the app is open refreshes what is on screen right away ([onRefresh]) and shows a short
///    banner with a "View" button: the person never has to pull to refresh.
///  * Tapping a notification (from the tray, with the app in the background or closed) refreshes and opens the right screen ([onOpen]).
///  * Coming back to the app refreshes too, because a notification may have been missed while the phone was asleep.
///
/// The apps decide WHAT to refresh and WHERE to go; this widget only decides WHEN.
class PushListener extends ConsumerStatefulWidget {
  const PushListener({super.key, required this.child, required this.onRefresh, required this.onOpen});

  final Widget child;

  /// Refresh what depends on the server. [message] is null when the app was simply brought back to the front.
  final void Function(WidgetRef ref, PushMessage? message) onRefresh;

  /// Open the screen a notification is about.
  final void Function(WidgetRef ref, PushMessage message) onOpen;

  @override
  ConsumerState<PushListener> createState() => _PushListenerState();
}

class _PushListenerState extends ConsumerState<PushListener> with WidgetsBindingObserver {
  final _subscriptions = <StreamSubscription<Object?>>[];
  bool _openedFromClosed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final push = ref.read(pushServiceProvider);
    _subscriptions
      ..add(push.foreground.listen(_onForeground))
      ..add(push.opened.listen(_onOpened))
      ..add(push.tokenRefreshed.listen((_) => _register()));
    if (ref.read(sessionUserProvider) != null) WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    for (final s in _subscriptions) {
      s.cancel();
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && ref.read(sessionUserProvider) != null) widget.onRefresh(ref, null);
  }

  /// Gets push ready, registers this phone, and opens the screen of the notification that started the app (once).
  Future<void> _bootstrap() async {
    final push = ref.read(pushServiceProvider);
    if (!await push.start() || !mounted) return;
    await _register();
    if (_openedFromClosed || !mounted) return;
    _openedFromClosed = true;
    final initial = await push.initialMessage();
    if (initial != null && mounted) {
      widget.onRefresh(ref, initial);
      widget.onOpen(ref, initial);
    }
  }

  Future<void> _register() async {
    if (ref.read(sessionUserProvider) == null) return;
    try {
      await ref.read(deviceRegistrationProvider).register();
    } catch (_) {
      // Not fatal: it is tried again at the next start, sign-in or token refresh.
    }
  }

  void _onForeground(PushMessage m) {
    if (!mounted || ref.read(sessionUserProvider) == null) return;
    widget.onRefresh(ref, m);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final title = m.title ?? '';
    final body = m.body ?? '';
    if (messenger == null || (title.isEmpty && body.isEmpty)) return;
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 6),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (title.isNotEmpty) Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
              if (body.isNotEmpty) Text(body, maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
          ),
          action: SnackBarAction(label: 'View', onPressed: () => widget.onOpen(ref, m)),
        ),
      );
  }

  void _onOpened(PushMessage m) {
    if (!mounted || ref.read(sessionUserProvider) == null) return;
    widget.onRefresh(ref, m);
    widget.onOpen(ref, m);
  }

  @override
  Widget build(BuildContext context) {
    // Signing in (or as someone else) on a phone that is already running: register it for THAT person.
    ref.listen<String?>(sessionUserProvider, (previous, next) {
      if (next != null && next != previous) unawaited(_bootstrap());
    });
    return widget.child;
  }
}
