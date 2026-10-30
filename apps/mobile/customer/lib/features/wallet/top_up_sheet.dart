import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:uuid/uuid.dart';

import '../../config/app_config.dart';
import '../../core/providers.dart';
import 'checkout_launcher.dart';
import 'wallet_state.dart';

enum _Phase { choosing, creating, paying, confirming, success, pending, failed }

/// Add money to the wallet.
///
/// The app never decides a payment worked. It asks the server to create a payment request, opens the provider's
/// checkout, and then asks the SERVER to verify with the provider; the wallet changes only when the server says so.
/// If confirmation is slow the person is told the truth ("not confirmed yet") and the server finishes the job later —
/// they are not charged twice.
class TopUpSheet extends ConsumerStatefulWidget {
  const TopUpSheet({super.key, this.suggestedMinor = 0});

  /// A starting amount in paise (e.g. the shortfall for a booking); rounded up to a whole ₹100.
  final int suggestedMinor;

  static Future<void> show(BuildContext context, {int suggestedMinor = 0}) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    enableDrag: false,
    builder: (_) => TopUpSheet(suggestedMinor: suggestedMinor),
  );

  @override
  ConsumerState<TopUpSheet> createState() => _TopUpSheetState();
}

class _TopUpSheetState extends ConsumerState<TopUpSheet> {
  static const _minRupees = 10;
  static const _maxRupees = 50000;

  late int _rupees;
  final _custom = TextEditingController();
  _Phase _phase = _Phase.choosing;
  String? _message;
  PaymentIntent? _intent;
  String? _attemptKey;
  int? _attemptMinor;

  @override
  void initState() {
    super.initState();
    final suggested = widget.suggestedMinor <= 0 ? 0 : ((widget.suggestedMinor + 9999) ~/ 10000) * 100;
    _rupees = suggested >= _minRupees ? suggested.clamp(_minRupees, _maxRupees) : 500;
    final matchesPreset = AppConfig.topUpPresetsRupees.contains(_rupees);
    if (!matchesPreset) _custom.text = '$_rupees';
  }

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  bool get _busy => _phase == _Phase.creating || _phase == _Phase.paying || _phase == _Phase.confirming;
  bool get _amountOk => _rupees >= _minRupees && _rupees <= _maxRupees;

  Future<void> _start() async {
    if (!_amountOk || _busy) return;
    final repo = ref.read(walletRepositoryProvider);
    final minor = _rupees * 100;
    // One key per (attempt, amount): retrying the SAME top-up never creates a second payment request.
    if (_attemptMinor != minor || _attemptKey == null) {
      _attemptKey = const Uuid().v4();
      _attemptMinor = minor;
      _intent = null;
    }
    setState(() {
      _phase = _Phase.creating;
      _message = null;
    });
    try {
      final intent = _intent ??= await repo.startTopUp(minor, idempotencyKey: _attemptKey!);
      final keyId = intent.razorpayKeyId;
      final orderId = intent.razorpayOrderId;
      if (keyId == null || orderId == null) {
        _fail('Adding money is not available in this version yet.');
        return;
      }
      setState(() => _phase = _Phase.paying);
      final outcome = await ref
          .read(checkoutLauncherProvider)
          .open(keyId: keyId, orderId: orderId, description: 'Add ${Money(minor).format()} to your TokenGo wallet');
      if (!mounted) return;
      await _confirm(intent, outcome);
    } on ApiException catch (e) {
      if (!mounted) return;
      // If the answer was lost (no connection) the server may have created the request: keep the key so a retry returns
      // that same request instead of making a second one. A definitive refusal starts fresh.
      _fail(
        e.code == 'TOPUP_AMOUNT_OUT_OF_RANGE' ? 'That amount is not allowed. Choose between ₹$_minRupees and ₹$_maxRupees.' : e.userMessage,
        keepAttempt: e.isNetwork,
      );
    }
  }

  /// Ask the SERVER whether the money arrived. Polls briefly, because the bank/provider can take a few seconds.
  Future<void> _confirm(PaymentIntent intent, CheckoutOutcome outcome) async {
    setState(() => _phase = _Phase.confirming);
    final repo = ref.read(walletRepositoryProvider);
    final attempts = outcome is CheckoutCompleted ? 8 : 1; // if the checkout reported no payment, check once and stop
    PaymentIntent latest = intent;
    for (var i = 0; i < attempts; i++) {
      try {
        latest = await repo.verifyTopUp(intent.id);
      } on ApiException catch (e) {
        if (!mounted) return;
        if (outcome is CheckoutCompleted) {
          // The checkout says money may have left the account but the server will not (or cannot) confirm it right now.
          // We do not KNOW, so say neither "added" nor "failed": the server settles it by itself once the provider confirms.
          setState(() {
            _phase = _Phase.pending;
            _message = e.isNetwork
                ? 'We could not reach the server to confirm your payment. If money left your account it will appear in your wallet once confirmed.'
                : 'We could not confirm your payment just yet. If money left your account it will appear in your wallet once confirmed — you will not be charged twice.';
          });
          return;
        }
        _fail(e.userMessage);
        return;
      }
      if (latest.isSucceeded) break;
      if (latest.isFinalFailure) break;
      if (i < attempts - 1) {
        await Future<void>.delayed(const Duration(milliseconds: 2500));
      }
      if (!mounted) return;
    }
    if (!mounted) return;
    refreshWallet(ref);
    if (latest.isSucceeded) {
      setState(() {
        _phase = _Phase.success;
        _intent = latest;
      });
    } else if (outcome is CheckoutCompleted && !latest.isFinalFailure) {
      setState(() {
        _phase = _Phase.pending;
        _message = 'Your payment has not been confirmed yet. This can take a few minutes. Your wallet updates by itself once it is — you will not be charged twice.';
      });
    } else if (outcome is CheckoutCancelled) {
      setState(() {
        _phase = _Phase.choosing;
        _message = 'Payment cancelled. You have not been charged.';
        _attemptKey = null;
        _intent = null;
      });
    } else {
      _fail(outcome is CheckoutFailed ? outcome.message : 'The payment did not go through. You have not been charged.');
    }
  }

  void _fail(String message, {bool keepAttempt = false}) {
    setState(() {
      _phase = _Phase.failed;
      _message = message;
      if (!keepAttempt) {
        _attemptKey = null;
        _intent = null;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    // While money may be moving, Back / tapping outside must not close the sheet and lose the confirmation.
    return PopScope(
      canPop: !_busy,
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xl + bottomInset),
          child: AnimatedSize(
            duration: const Duration(milliseconds: 200),
            alignment: Alignment.topCenter,
            child: switch (_phase) {
              _Phase.success => _Result(
                icon: Icons.check_circle_rounded,
                art: BrandArt.successPayment,
                tone: Tone.success,
                title: '${Money(_rupees * 100).format()} added',
                message: 'Your wallet is updated. Happy booking!',
                buttonLabel: 'Done',
                onPressed: () => Navigator.of(context).pop(),
              ),
              _Phase.pending => _Result(
                icon: Icons.hourglass_top_rounded,
                tone: Tone.warning,
                title: 'Waiting for confirmation',
                message: _message ?? '',
                buttonLabel: 'Check again',
                onPressed: _intent == null ? () => Navigator.of(context).pop() : () => _confirm(_intent!, const CheckoutCompleted()),
                secondaryLabel: 'Close',
                onSecondary: () => Navigator.of(context).pop(),
              ),
              _Phase.failed => _Result(
                icon: Icons.error_outline_rounded,
                art: BrandArt.errorPaymentFailed,
                tone: Tone.danger,
                title: 'Payment not completed',
                message: _message ?? '',
                buttonLabel: 'Try again',
                onPressed: () => setState(() => _phase = _Phase.choosing),
                secondaryLabel: 'Close',
                onSecondary: () => Navigator.of(context).pop(),
              ),
              _ => _chooser(t),
            },
          ),
        ),
      ),
    );
  }

  Widget _chooser(ThemeData t) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text('Add money', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            ),
            IconButton(
              tooltip: 'Close',
              onPressed: _busy ? null : () => Navigator.of(context).pop(),
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
        const SizedBox(height: Gap.xs),
        Text(
          'Secure payment through Razorpay. Money in your wallet is used for bookings and refunded to you if a booking is cancelled.',
          style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: Gap.lg),
        Wrap(
          spacing: Gap.sm,
          runSpacing: Gap.sm,
          children: [
            for (final r in AppConfig.topUpPresetsRupees)
              ChoiceChip(
                label: Text('₹$r'),
                selected: _rupees == r && _custom.text.isEmpty,
                onSelected: _busy
                    ? null
                    : (_) => setState(() {
                        _rupees = r;
                        _custom.clear();
                        _message = null;
                      }),
              ),
          ],
        ),
        const SizedBox(height: Gap.md),
        TextField(
          controller: _custom,
          enabled: !_busy,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          onChanged: (v) => setState(() {
            if (v.isNotEmpty) _rupees = int.tryParse(v) ?? 0;
          }),
          decoration: InputDecoration(
            labelText: 'Or enter an amount',
            prefixText: '₹ ',
            helperText: 'Between ₹$_minRupees and ₹$_maxRupees',
            errorText: _custom.text.isNotEmpty && !_amountOk ? 'Enter ₹$_minRupees to ₹$_maxRupees' : null,
          ),
        ),
        if (_message != null) ...[
          const SizedBox(height: Gap.md),
          Text(
            _message!,
            style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w600),
          ),
        ],
        const SizedBox(height: Gap.xl),
        FilledButton(
          onPressed: _amountOk && !_busy ? _start : null,
          child: _busy
              ? Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5)),
                    const SizedBox(width: Gap.md),
                    Text(switch (_phase) {
                      _Phase.creating => 'Preparing…',
                      _Phase.paying => 'Complete payment…',
                      _ => 'Confirming with your bank…',
                    }),
                  ],
                )
              : Text('Add ${Money(_rupees * 100).format()}'),
        ),
      ],
    );
  }
}

class _Result extends StatelessWidget {
  const _Result({
    required this.icon,
    this.art,
    required this.tone,
    required this.title,
    required this.message,
    required this.buttonLabel,
    required this.onPressed,
    this.secondaryLabel,
    this.onSecondary,
  });

  final IconData icon;

  /// The brand illustration for this result; the icon is the fallback.
  final BrandArt? art;
  final Tone tone;
  final String title;
  final String message;
  final String buttonLabel;
  final VoidCallback onPressed;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final s = context.statusColors;
    final color = switch (tone) {
      Tone.success => s.success,
      Tone.warning => s.warning,
      Tone.danger => s.danger,
      _ => t.colorScheme.primary,
    };
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (art != null) BrandImage(art!, height: 104) else Icon(icon, size: 64, color: color),
        const SizedBox(height: Gap.md),
        Text(
          title,
          style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: Gap.sm),
        Text(
          message,
          style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: Gap.xl),
        FilledButton(onPressed: onPressed, child: Text(buttonLabel)),
        if (secondaryLabel != null) TextButton(onPressed: onSecondary, child: Text(secondaryLabel!)),
      ],
    );
  }
}
