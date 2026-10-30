import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../net/api_exception.dart';
import '../state/session_providers.dart';
import '../theme/app_theme.dart';
import '../util/whatsapp_otp_autofill.dart';
import 'brand.dart';
import 'widgets.dart';

/// Step 1 of sign-in: the mobile number. There is no separate "register": a new number simply becomes a new account.
/// The screen knows nothing about navigation: the app says what happens next ([onCodeSent]).
class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({
    super.key,
    required this.heading,
    required this.blurb,
    required this.onCodeSent,
    this.footnote,
    this.showBack = false,
  });

  final String heading;
  final String blurb;
  final String? footnote;
  final bool showBack;

  /// Called with the 10-digit number once the server has sent a code.
  final void Function(String phone) onCodeSent;

  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  final _controller = TextEditingController();
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _valid => RegExp(r'^[6-9]\d{9}$').hasMatch(_controller.text);

  Future<void> _send() async {
    if (!_valid || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final phone = _controller.text;
    try {
      await ref.read(whatsAppOtpAutofillProvider).startHandshake(); // must come BEFORE the code is sent; never fails
      await ref.read(authRepositoryProvider).requestOtp(phone);
      if (!mounted) return;
      widget.onCodeSent(phone);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = e is ApiException && e.code == 'RATE_LIMITED'
              ? 'Too many attempts. Please wait a few minutes and try again.'
              : errorMessage(e),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return Scaffold(
      appBar: AppBar(leading: widget.showBack ? const BackButton() : null),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.sm, Gap.xl, Gap.xl),
          children: [
            const Align(alignment: Alignment.centerLeft, child: BrandLogo(style: BrandLogoStyle.horizontal, height: 56)),
            const SizedBox(height: Gap.xxl),
            Text(widget.heading, style: t.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, height: 1.15)),
            const SizedBox(height: Gap.sm),
            Text(widget.blurb, style: t.textTheme.bodyLarge?.copyWith(color: c.onSurfaceVariant)),
            const SizedBox(height: Gap.xxl),
            TextField(
              controller: _controller,
              autofocus: true,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.done,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
              onChanged: (_) => setState(() => _error = null),
              onSubmitted: (_) => _send(),
              style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: 1),
              decoration: InputDecoration(
                labelText: 'Mobile number',
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(left: Gap.lg, right: Gap.md),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('+91', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                      const SizedBox(width: Gap.md),
                      SizedBox(height: 24, child: VerticalDivider(width: 1, color: c.outlineVariant)),
                    ],
                  ),
                ),
                errorText: _error,
              ),
            ),
            const SizedBox(height: Gap.xl),
            FilledButton(
              onPressed: _valid && !_sending ? _send : null,
              child: _sending
                  ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Text('Send code'),
            ),
            if (widget.footnote != null) ...[
              const SizedBox(height: Gap.xl),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.lock_outline_rounded, size: 16, color: c.outline),
                  const SizedBox(width: Gap.sm),
                  Expanded(child: Text(widget.footnote!, style: t.textTheme.bodySmall?.copyWith(color: c.onSurfaceVariant))),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Step 2 of sign-in: the 6-digit code. Verifying signs in (the session changes); the app's router then leaves this screen.
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key, required this.phone, required this.onChangeNumber, required this.onSignedIn});

  final String phone;
  final VoidCallback onChangeNumber;

  /// Called once the server accepted the code and the session is stored: the app says where to go next. This is explicit
  /// on purpose — a router `redirect` is NOT re-run for screens opened with `push`, so relying on it left people stuck here.
  final VoidCallback onSignedIn;

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

/// The 6-digit login code inside [text] (what WhatsApp's "Copy code" button puts on the clipboard), or null if [text] is anything
/// else. Deliberately strict: only a lone code counts, never a number picked out of a longer text.
@visibleForTesting
String? loginCodeIn(String? text) {
  final compact = text?.replaceAll(RegExp(r'[\s-]'), '');
  return compact != null && RegExp(r'^\d{6}$').hasMatch(compact) ? compact : null;
}

class _OtpScreenState extends ConsumerState<OtpScreen> with WidgetsBindingObserver {
  static const _resendSeconds = 30;

  /// How long the code screen keeps looking for a code that WhatsApp handed over (the native side keeps one for 10 minutes).
  static const _pollSeconds = 600;
  final _controller = TextEditingController();
  final _focus = FocusNode();
  Timer? _timer;
  Timer? _poll;
  int _polls = 0;
  StreamSubscription<void>? _autofill;

  /// Codes already sent to the server (right or wrong): never offered again, so one stale code cannot loop.
  final _spent = <String>{};
  int _left = _resendSeconds;
  bool _verifying = false;
  bool _resending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startCountdown();
    // WhatsApp one-tap / zero-tap: the code can arrive while this screen is open, or while the app was in the background (one-tap
    // brings the app back to the front). Either way it is claimed once and submitted like a typed code.
    final autofill = ref.read(whatsAppOtpAutofillProvider);
    _autofill = autofill.codeAvailable.listen((_) => _claimAutofilledCode());
    _claimAutofilledCode();
    // Safety net: the "a code has arrived" notification can be missed (the Android side was re-created, or the code came in a
    // moment before this screen was listening), and then the code would sit unclaimed while the person types it by hand. Asking
    // once a second costs nothing (it is an in-memory read) and makes autofill work every time, not just the first.
    _poll = Timer.periodic(const Duration(seconds: 1), (t) {
      if (++_polls > _pollSeconds) {
        t.cancel();
      } else if (!_verifying && _controller.text.isEmpty) {
        _claimAutofilledCode();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // Coming back from WhatsApp: either WhatsApp handed the code over (one-tap), or the person tapped "Copy code" there.
    _claimAutofilledCode().then((_) {
      if (mounted && _controller.text.isEmpty) _pasteFromClipboard(auto: true);
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _autofill?.cancel();
    _poll?.cancel();
    _timer?.cancel();
    _focus.dispose();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _claimAutofilledCode() async {
    if (_verifying) return; // leave the code waiting rather than throw it away mid-verification
    final code = await ref.read(whatsAppOtpAutofillProvider).takePendingCode();
    if (code == null || !mounted || _verifying) return;
    _controller.text = code;
    setState(() => _error = null);
    await _verify();
  }

  /// WhatsApp's own "Copy code" button works on every phone, so a code on the clipboard is the fallback when WhatsApp could not
  /// hand it over by itself. [auto] is the silent check when the app comes back to the front; otherwise the person asked for it.
  Future<void> _pasteFromClipboard({bool auto = false}) async {
    if (_verifying) return;
    String? text;
    try {
      text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    } catch (_) {
      // A clipboard that cannot be read is just "no code there".
    }
    if (!mounted || _verifying) return;
    final code = loginCodeIn(text);
    if (code == null || _spent.contains(code)) {
      if (!auto) showSnack(context, 'No new 6-digit code found. In WhatsApp, tap "Copy code" on the message, then come back.');
      return;
    }
    _controller.text = code;
    setState(() => _error = null);
    await _verify();
  }

  void _startCountdown() {
    _timer?.cancel();
    setState(() => _left = _resendSeconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_left <= 1) {
        t.cancel();
      }
      if (mounted) setState(() => _left = (_left - 1).clamp(0, _resendSeconds));
    });
  }

  Future<void> _verify() async {
    if (_controller.text.length != 6 || _verifying) return;
    final code = _controller.text;
    _spent.add(code);
    setState(() {
      _verifying = true;
      _error = null;
    });
    try {
      await ref.read(authRepositoryProvider).verifyOtp(widget.phone, code);
      if (mounted) widget.onSignedIn();
    } catch (e) {
      if (!mounted) return;
      _controller.clear();
      setState(
        () => _error = e is ApiException && e.isUnauthenticated
            ? 'That code is not right or has expired. Check it and try again.'
            : errorMessage(e),
      );
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  Future<void> _resend() async {
    if (_left > 0 || _resending) return;
    setState(() => _resending = true);
    try {
      await ref.read(whatsAppOtpAutofillProvider).startHandshake(); // a fresh handshake for the fresh code
      await ref.read(authRepositoryProvider).requestOtp(widget.phone);
      if (mounted) {
        showSnack(context, 'A new code is on its way.');
        _startCountdown();
      }
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    final waiting = _left > 0 && !_verifying && _controller.text.isEmpty && _error == null;
    return Scaffold(
      appBar: AppBar(),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.sm, Gap.xl, Gap.xl),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Container(
                width: 56,
                height: 56,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: c.primaryContainer, borderRadius: BorderRadius.circular(Corners.lg)),
                child: Icon(Icons.mark_chat_read_outlined, color: c.onPrimaryContainer, size: 28),
              ),
            ),
            const SizedBox(height: Gap.lg),
            Text('Enter the code', style: t.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: Gap.sm),
            Text.rich(
              TextSpan(
                text: 'We sent a 6-digit code on WhatsApp to ',
                children: [TextSpan(text: '+91 ${widget.phone}', style: const TextStyle(fontWeight: FontWeight.w700))],
              ),
              style: t.textTheme.bodyLarge?.copyWith(color: c.onSurfaceVariant),
            ),
            const SizedBox(height: Gap.xxl),
            _CodeBoxes(
              controller: _controller,
              focusNode: _focus,
              hasError: _error != null,
              onChanged: (v) {
                setState(() => _error = null);
                if (v.length == 6) _verify(); // submit as soon as the last digit is typed
              },
            ),
            AnimatedSize(
              duration: const Duration(milliseconds: 150),
              alignment: Alignment.topCenter,
              child: _error != null
                  ? Padding(
                      padding: const EdgeInsets.only(top: Gap.md),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.error_outline_rounded, size: 18, color: c.error),
                          const SizedBox(width: Gap.sm),
                          Expanded(child: Text(_error!, style: t.textTheme.bodyMedium?.copyWith(color: c.error))),
                        ],
                      ),
                    )
                  : waiting
                  ? Padding(
                      padding: const EdgeInsets.only(top: Gap.md),
                      child: Row(
                        children: [
                          SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2, color: c.outline)),
                          const SizedBox(width: Gap.sm),
                          Expanded(
                            child: Text(
                              'Waiting for your code. It fills in by itself when it arrives.',
                              style: t.textTheme.bodySmall?.copyWith(color: c.onSurfaceVariant),
                            ),
                          ),
                        ],
                      ),
                    )
                  : const SizedBox(width: double.infinity),
            ),
            const SizedBox(height: Gap.xl),
            FilledButton(
              onPressed: _controller.text.length == 6 && !_verifying ? _verify : null,
              child: _verifying
                  ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Text('Verify and continue'),
            ),
            const SizedBox(height: Gap.lg),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                TextButton.icon(
                  onPressed: _verifying ? null : () => _pasteFromClipboard(),
                  icon: const Icon(Icons.content_paste_rounded, size: 18),
                  label: const Text('Paste code'),
                ),
                TextButton(
                  onPressed: _left == 0 && !_resending ? _resend : null,
                  child: Text(_left > 0 ? 'Resend in $_left s' : 'Resend code'),
                ),
              ],
            ),
            Center(
              child: TextButton(onPressed: widget.onChangeNumber, child: const Text('Use a different number')),
            ),
          ],
        ),
      ),
    );
  }
}

/// Six boxes for the six digits. The REAL input is a text field hidden behind them, so the keyboard, paste and autofill all work
/// as they do for any field, and tests (and screen readers) can still enter or read the code.
class _CodeBoxes extends StatelessWidget {
  const _CodeBoxes({required this.controller, required this.focusNode, required this.hasError, required this.onChanged});

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool hasError;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return AnimatedBuilder(
      animation: Listenable.merge([controller, focusNode]),
      builder: (context, _) {
        final text = controller.text;
        final focused = focusNode.hasFocus;
        return Semantics(
          label: 'Login code, 6 digits',
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () {
              focusNode.requestFocus();
              SystemChannels.textInput.invokeMethod<void>('TextInput.show');
            },
            child: SizedBox(
              height: 60,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Opacity(
                      opacity: 0,
                      child: TextField(
                        controller: controller,
                        focusNode: focusNode,
                        autofocus: true,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        showCursor: false,
                        enableInteractiveSelection: false,
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                        onChanged: onChanged,
                        decoration: const InputDecoration(counterText: '', border: InputBorder.none, filled: false),
                      ),
                    ),
                  ),
                  IgnorePointer(
                    child: Row(
                      children: [
                        for (var i = 0; i < 6; i++) ...[
                          if (i > 0) const SizedBox(width: Gap.sm),
                          Expanded(
                            child: AnimatedContainer(
                              duration: const Duration(milliseconds: 120),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: i < text.length ? c.primaryContainer.withValues(alpha: 0.5) : c.surfaceContainerHighest.withValues(alpha: 0.5),
                                borderRadius: BorderRadius.circular(Corners.md),
                                border: Border.all(
                                  color: hasError
                                      ? c.error
                                      : (focused && i == text.length.clamp(0, 5))
                                      ? c.primary
                                      : Colors.transparent,
                                  width: 2,
                                ),
                              ),
                              child: Text(
                                i < text.length ? text[i] : '',
                                style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
