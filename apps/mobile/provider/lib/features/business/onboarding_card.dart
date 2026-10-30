import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

/// Asks TokenGo to review the business. The server moves DRAFT/REJECTED to SUBMITTED (and refuses anything else, with a
/// reason we show); afterwards every screen re-reads the business from the server. Returns whether the server accepted it.
///
/// [onBusy] is called with true just before the request is sent (not while the confirmation is showing) and false after it.
Future<bool> submitForReview(BuildContext context, WidgetRef ref, ProviderAccount business, {void Function(bool busy)? onBusy}) async {
  final resubmit = business.isRejected;
  final ok = await confirmAction(
    context,
    title: resubmit ? 'Submit again for review?' : 'Submit for review?',
    message:
        'TokenGo checks your business before it appears to customers. You can keep editing while you wait, and you will see the '
        'decision here.',
    confirmLabel: 'Submit',
  );
  if (!ok || !context.mounted) return false;
  var accepted = false;
  onBusy?.call(true);
  try {
    await ref.read(setupRepositoryProvider).submit(business.id);
    accepted = true;
    if (context.mounted) showSnack(context, 'Submitted. TokenGo will review your business.');
  } catch (e) {
    if (context.mounted) showSnack(context, errorMessage(e), error: true);
  } finally {
    refreshSetup(ref);
    onBusy?.call(false);
  }
  return accepted;
}

/// The new-owner checklist: what is done, what is next, and a button that goes straight to the next step.
class OnboardingCard extends ConsumerStatefulWidget {
  const OnboardingCard({super.key, this.hideWhenComplete = true});

  /// On the Business tab the finished checklist is hidden; on Today it is hidden too (nothing left to do).
  final bool hideWhenComplete;

  @override
  ConsumerState<OnboardingCard> createState() => _OnboardingCardState();
}

class _OnboardingCardState extends ConsumerState<OnboardingCard> {
  bool _submitting = false;

  Future<void> _open(OnboardingStep step, OnboardingChecklist c) async {
    switch (step.id) {
      case OnboardingStepId.business:
        context.push('/register');
      case OnboardingStepId.location:
        context.push('/manage/locations/new');
      case OnboardingStepId.service:
        context.push('/manage/services/new');
      case OnboardingStepId.hours:
        final locations = ref.read(locationsProvider).value?.where((l) => l.isActive).toList() ?? const <OwnedLocation>[];
        context.push(locations.length == 1 ? '/manage/locations/${locations.single.id}/hours' : '/manage/locations');
      case OnboardingStepId.staff:
        context.push('/manage/staff/new');
      case OnboardingStepId.submit:
        final business = c.business;
        if (business == null || _submitting) return;
        await submitForReview(
          context,
          ref,
          business,
          onBusy: (busy) {
            if (mounted) setState(() => _submitting = busy);
          },
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final checklist = ref.watch(onboardingProvider);
    final t = Theme.of(context);
    return checklist.when(
      skipLoadingOnReload: true,
      loading: () => const Padding(
        padding: EdgeInsets.all(Gap.xl),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(Gap.lg),
            child: Row(
              children: [
                Expanded(child: Text('Could not load your setup steps. ${errorMessage(e)}')),
                TextButton(onPressed: () => refreshSetup(ref), child: const Text('Retry')),
              ],
            ),
          ),
        ),
      ),
      data: (c) {
        if (c.isComplete && widget.hideWhenComplete) return const SizedBox.shrink();
        final next = c.next;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(Gap.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('Set up your business', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                      ),
                      Text('${c.doneCount} of ${c.steps.length}', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary)),
                    ],
                  ),
                  const SizedBox(height: Gap.sm),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(Corners.pill),
                    child: LinearProgressIndicator(value: c.doneCount / c.steps.length, minHeight: 6),
                  ),
                  const SizedBox(height: Gap.md),
                  for (final s in c.steps) _StepRow(step: s, isNext: identical(s, next), onTap: s.done ? null : () => _open(s, c), c: c),
                  if (next != null) ...[
                    const SizedBox(height: Gap.md),
                    BusyButton(
                      label: next.id == OnboardingStepId.submit ? 'Submit for review' : next.title,
                      busy: _submitting && next.id == OnboardingStepId.submit,
                      onPressed: c.canStart(next.id) ? () => _open(next, c) : null,
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step, required this.isNext, required this.onTap, required this.c});

  final OnboardingStep step;
  final bool isNext;
  final VoidCallback? onTap;
  final OnboardingChecklist c;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final locked = !step.done && !c.canStart(step.id);
    final color = step.done ? context.statusColors.success : (isNext ? t.colorScheme.primary : t.colorScheme.outline);
    return InkWell(
      borderRadius: BorderRadius.circular(Corners.sm),
      onTap: locked ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Gap.sm),
        child: Row(
          children: [
            Icon(
              step.done ? Icons.check_circle_rounded : (isNext ? Icons.radio_button_checked : Icons.radio_button_unchecked),
              color: color,
            ),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    step.title,
                    style: t.textTheme.bodyLarge?.copyWith(
                      fontWeight: isNext ? FontWeight.w700 : FontWeight.w500,
                      color: locked ? t.colorScheme.outline : null,
                    ),
                  ),
                  Text(step.hint, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
            if (!step.done && !locked) Icon(Icons.chevron_right_rounded, color: t.colorScheme.outline),
          ],
        ),
      ),
    );
  }
}
