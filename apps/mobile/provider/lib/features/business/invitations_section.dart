import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

/// Invitations to join a business as staff, addressed to this person's phone number. Nobody is attached to a business without
/// accepting here: the server only links the account on "Accept".
class InvitationsSection extends ConsumerStatefulWidget {
  const InvitationsSection({super.key});

  @override
  ConsumerState<InvitationsSection> createState() => _InvitationsSectionState();
}

class _InvitationsSectionState extends ConsumerState<InvitationsSection> {
  final _busy = <String>{};

  Future<void> _accept(StaffInvitation i) async {
    if (_busy.contains(i.id)) return;
    setState(() => _busy.add(i.id));
    try {
      await ref.read(setupRepositoryProvider).acceptInvitation(i.id);
      if (mounted) {
        showSnack(context, 'You joined ${i.providerName} as ${i.roleLabel.toLowerCase()}. The owner manages your hours and services.');
      }
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      // Whatever the server said, show what it now holds.
      ref.invalidate(invitationsProvider);
      ref.invalidate(myBusinessesProvider);
      if (mounted) setState(() => _busy.remove(i.id));
    }
  }

  Future<void> _decline(StaffInvitation i) async {
    if (_busy.contains(i.id)) return;
    final ok = await confirmAction(
      context,
      title: 'Decline this invitation?',
      message: '${i.providerName} will not be able to add you unless they invite you again.',
      confirmLabel: 'Decline',
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() => _busy.add(i.id));
    try {
      await ref.read(setupRepositoryProvider).declineInvitation(i.id);
      if (mounted) showSnack(context, 'Invitation declined.');
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      ref.invalidate(invitationsProvider);
      if (mounted) setState(() => _busy.remove(i.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final invitations = ref.watch(invitationsProvider);
    final t = Theme.of(context);
    return invitations.when(
      skipLoadingOnReload: true,
      loading: () => const SizedBox.shrink(),
      error: (e, _) => Padding(
        padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
        child: Card(
          child: ListTile(
            leading: const Icon(Icons.mail_outline_rounded),
            title: const Text('Could not check your staff invitations'),
            subtitle: Text(errorMessage(e)),
            trailing: TextButton(onPressed: () => ref.invalidate(invitationsProvider), child: const Text('Retry')),
          ),
        ),
      ),
      data: (list) {
        if (list.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                list.length == 1 ? 'You have an invitation' : 'You have ${list.length} invitations',
                style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: Gap.sm),
              for (final i in list)
                Padding(
                  padding: const EdgeInsets.only(bottom: Gap.md),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(Gap.lg),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${i.providerName} invited you to work at ${i.locationName}',
                            style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: Gap.xs),
                          Text(
                            'As ${i.roleLabel.toLowerCase()}, listed as "${i.invitedAs}". Accepting lets this business schedule you.',
                            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                          ),
                          const SizedBox(height: Gap.md),
                          Row(
                            children: [
                              Expanded(
                                child: OutlinedButton(
                                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                                  onPressed: _busy.contains(i.id) ? null : () => _decline(i),
                                  child: const Text('Decline'),
                                ),
                              ),
                              const SizedBox(width: Gap.md),
                              Expanded(
                                child: FilledButton(
                                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                                  onPressed: _busy.contains(i.id) ? null : () => _accept(i),
                                  child: _busy.contains(i.id)
                                      ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2.5))
                                      : const Text('Accept'),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
