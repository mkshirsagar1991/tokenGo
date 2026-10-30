import 'package:flutter/material.dart';

import '../models/booking.dart';
import '../net/api_exception.dart';
import '../theme/app_theme.dart';
import 'brand.dart';

/// Turns anything thrown into text a person can read.
String errorMessage(Object error) => error is ApiException ? error.userMessage : 'Something went wrong. Please try again.';

void showSnack(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.of(context);
  messenger
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(message), backgroundColor: error ? Theme.of(context).colorScheme.error : null));
}

/// A failed load, with a way to try again.
class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.error, this.onRetry});

  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final offline = error is ApiException && (error as ApiException).isNetwork;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (offline)
              const BrandImage(BrandArt.errorNoInternet, height: 96)
            else
              Icon(Icons.error_outline_rounded, size: 48, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: Gap.md),
            Text(errorMessage(error), textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
            if (onRetry != null) ...[
              const SizedBox(height: Gap.lg),
              FilledButton.tonalIcon(
                style: FilledButton.styleFrom(minimumSize: const Size(160, 44)),
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.message, this.action, this.art});

  final IconData icon;

  /// The brand illustration for this kind of emptiness. Without one, [icon] is shown.
  final BrandArt? art;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (art != null) BrandImage(art!, height: 112) else Icon(icon, size: 56, color: t.colorScheme.primary.withValues(alpha: 0.7)),
            const SizedBox(height: Gap.lg),
            Text(title, style: t.textTheme.titleLarge, textAlign: TextAlign.center),
            if (message != null) ...[
              const SizedBox(height: Gap.sm),
              Text(
                message!,
                style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
            if (action != null) ...[const SizedBox(height: Gap.xl), action!],
          ],
        ),
      ),
    );
  }
}

enum Tone { neutral, success, warning, danger, info }

/// A small status label with a semantic colour.
class StatusPill extends StatelessWidget {
  const StatusPill(this.label, {super.key, this.tone = Tone.neutral});

  final String label;
  final Tone tone;

  @override
  Widget build(BuildContext context) {
    final s = context.statusColors;
    final c = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone) {
      Tone.success => (s.successContainer, s.success),
      Tone.warning => (s.warningContainer, s.warning),
      Tone.danger => (s.dangerContainer, s.danger),
      Tone.info => (s.infoContainer, s.info),
      Tone.neutral => (c.surfaceContainerHighest, c.onSurfaceVariant),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.xs + 1),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Corners.pill)),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(color: fg, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// How a booking status is coloured everywhere in the app.
Tone bookingTone(String status) => switch (status) {
  BookingStatus.requested => Tone.warning,
  BookingStatus.confirmed || BookingStatus.customerArrived || BookingStatus.serviceStarted => Tone.info,
  BookingStatus.serviceCompleted => Tone.warning,
  BookingStatus.closed => Tone.success,
  BookingStatus.providerRejected ||
  BookingStatus.providerCancelled ||
  BookingStatus.expired ||
  BookingStatus.noShow ||
  BookingStatus.disputed => Tone.danger,
  _ => Tone.neutral,
};

class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.xl, Gap.lg, Gap.sm),
    child: Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        ),
        ?trailing,
      ],
    ),
  );
}

/// Shown instead of a screen that needs an account.
class SignInPrompt extends StatelessWidget {
  const SignInPrompt({super.key, required this.title, required this.message, required this.onSignIn});

  final String title;
  final String message;
  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) => EmptyState(
    icon: Icons.lock_outline_rounded,
    title: title,
    message: message,
    action: FilledButton(
      style: FilledButton.styleFrom(minimumSize: const Size(220, 52)),
      onPressed: onSignIn,
      child: const Text('Sign in with your phone'),
    ),
  );
}
