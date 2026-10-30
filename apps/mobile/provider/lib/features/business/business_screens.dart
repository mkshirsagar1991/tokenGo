import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';
import 'invitations_section.dart';
import 'onboarding_card.dart';

/// First screen of the new-owner journey: the name customers will see. The server creates the business as a DRAFT and makes
/// this person its owner; nothing is visible to customers until TokenGo approves it.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _name = TextEditingController();
  final _description = TextEditingController();
  final _errors = ServerErrors();
  final _attempt = AttemptKey();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  FieldProblems _validate() {
    final p = <String, String>{};
    final n = _name.text.trim().length;
    if (n < 2) p['display_name'] = 'Enter your business name (at least 2 characters)';
    if (n > 120) p['display_name'] = 'The name is too long (at most 120 characters)';
    if (_description.text.trim().length > 2000) p['description'] = 'Too long (at most 2000 characters)';
    return p;
  }

  Future<void> _save() async {
    if (_busy) return;
    final problems = _validate();
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      // One key per attempt: a retry after a dropped connection returns the SAME business instead of creating a second.
      final key = _attempt.keyFor({'n': _name.text.trim(), 'd': _description.text.trim()});
      await ref.read(setupRepositoryProvider).register(displayName: _name.text, description: _description.text, idempotencyKey: key);
      _attempt.reset();
      refreshSetup(ref);
      if (!mounted) return;
      showSnack(context, 'Business registered. Next: add your location.');
      context.go('/');
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Register your business')),
      body: ListView(
        padding: const EdgeInsets.all(Gap.lg),
        children: [
          Text(
            'Customers will find you under this name. You can change it later.',
            style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: Gap.lg),
          FormBanner(_errors.banner({'display_name', 'description'})),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            maxLength: 120,
            onChanged: (_) => setState(() => _errors.clearField('display_name')),
            decoration: InputDecoration(labelText: 'Business name', errorText: _errors.field('display_name'), counterText: ''),
          ),
          const SizedBox(height: Gap.md),
          TextField(
            controller: _description,
            maxLines: 4,
            maxLength: 2000,
            onChanged: (_) => setState(() => _errors.clearField('description')),
            decoration: InputDecoration(
              labelText: 'About your business (optional)',
              alignLabelWithHint: true,
              errorText: _errors.field('description'),
            ),
          ),
          const SizedBox(height: Gap.xl),
          BusyButton(label: 'Register business', busy: _busy, onPressed: _save),
        ],
      ),
    );
  }
}

/// Edit the name and description, see the review status (and the reason when rejected or suspended), and submit for review.
class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final _name = TextEditingController();
  final _description = TextEditingController();
  final _errors = ServerErrors();
  String? _loadedFor;
  bool _busy = false;
  bool _submitting = false;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  void _load(ProviderAccount b) {
    // Fill the form once per version of the business, never overwriting what the person is typing.
    final marker = '${b.id}:${b.version}';
    if (_loadedFor == marker) return;
    _loadedFor = marker;
    // After the frame: changing a controller while the field is being built is an error.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _name.text = b.displayName;
      _description.text = b.description ?? '';
    });
  }

  Future<void> _save(ProviderAccount b) async {
    if (_busy) return;
    final problems = <String, String>{};
    final n = _name.text.trim().length;
    if (n < 2 || n > 120) problems['display_name'] = 'The name must be 2 to 120 characters';
    if (_description.text.trim().length > 2000) problems['description'] = 'Too long (at most 2000 characters)';
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    final nameChanged = _name.text.trim() != b.displayName;
    final descChanged = _description.text.trim() != (b.description ?? '');
    if (!nameChanged && !descChanged) {
      showSnack(context, 'Nothing to save.');
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      await ref
          .read(setupRepositoryProvider)
          .updateProfile(b.id, displayName: nameChanged ? _name.text : null, description: descChanged ? _description.text : null);
      if (mounted) showSnack(context, 'Saved.');
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      refreshSetup(ref);
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit(ProviderAccount b) async {
    if (_submitting) return;
    await submitForReview(
      context,
      ref,
      b,
      onBusy: (busy) {
        if (mounted) setState(() => _submitting = busy);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final business = ref.watch(currentBusinessProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Business profile')),
      body: AsyncView(
        value: business,
        onRetry: () => ref.invalidate(myBusinessesProvider),
        builder: (b) {
          if (b == null) return const EmptyState(icon: Icons.storefront_outlined, title: 'No business yet');
          _load(b);
          final t = Theme.of(context);
          return ListView(
            padding: const EdgeInsets.all(Gap.lg),
            children: [
              ReviewStatusCard(business: b),
              const SizedBox(height: Gap.lg),
              FormBanner(_errors.banner({'display_name', 'description'})),
              TextField(
                controller: _name,
                enabled: b.canEdit,
                textCapitalization: TextCapitalization.words,
                maxLength: 120,
                onChanged: (_) => setState(() => _errors.clearField('display_name')),
                decoration: InputDecoration(labelText: 'Business name', errorText: _errors.field('display_name'), counterText: ''),
              ),
              const SizedBox(height: Gap.md),
              TextField(
                controller: _description,
                enabled: b.canEdit,
                maxLines: 4,
                maxLength: 2000,
                onChanged: (_) => setState(() => _errors.clearField('description')),
                decoration: InputDecoration(
                  labelText: 'About your business',
                  alignLabelWithHint: true,
                  errorText: _errors.field('description'),
                ),
              ),
              const SizedBox(height: Gap.lg),
              if (b.canEdit) BusyButton(label: 'Save changes', busy: _busy, onPressed: () => _save(b)),
              if (b.canSubmit) ...[
                const SizedBox(height: Gap.md),
                OutlinedButton(
                  onPressed: _submitting ? null : () => _submit(b),
                  child: Text(b.isRejected ? 'Submit again for review' : 'Submit for review'),
                ),
              ],
              if (b.isSuspended)
                Padding(
                  padding: const EdgeInsets.only(top: Gap.md),
                  child: Text(
                    'A suspended business cannot be edited. Contact TokenGo support.',
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// The review status in plain words, with TokenGo's reason when it rejected or suspended the business.
class ReviewStatusCard extends StatelessWidget {
  const ReviewStatusCard({super.key, required this.business});

  final ProviderAccount business;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final b = business;
    final tone = b.isApproved
        ? Tone.success
        : (b.isRejected || b.isSuspended)
        ? Tone.danger
        : (b.isInReview ? Tone.info : Tone.warning);
    final text = switch (b.status) {
      ProviderAccount.draft =>
        'Finish the steps below, then submit your business for review. Customers cannot see it until it is approved.',
      ProviderAccount.submitted => 'TokenGo has your business and will review it soon. You can keep editing meanwhile.',
      ProviderAccount.underReview => 'TokenGo is reviewing your business now.',
      ProviderAccount.approved => 'Your business is live: customers can find it and request bookings.',
      ProviderAccount.rejected => 'TokenGo did not approve your business yet. Fix what is listed below and submit it again.',
      ProviderAccount.suspended => 'Your business is suspended: it does not appear to customers and cannot take bookings.',
      _ => b.statusLabel,
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(b.displayName, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: Gap.sm),
            Align(
              alignment: Alignment.centerLeft,
              child: StatusPill(b.statusLabel, tone: tone),
            ),
            const SizedBox(height: Gap.sm),
            Text(text, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            if ((b.isRejected || b.isSuspended) && b.decisionReason != null) ...[
              const SizedBox(height: Gap.md),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(Gap.md),
                decoration: BoxDecoration(color: context.statusColors.dangerContainer, borderRadius: BorderRadius.circular(Corners.md)),
                child: Text(
                  'Reason: ${b.decisionReason}',
                  style: t.textTheme.bodyMedium?.copyWith(color: context.statusColors.danger, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The Business tab: status, the setup checklist, and everything the owner manages.
class BusinessHubScreen extends ConsumerWidget {
  const BusinessHubScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final business = ref.watch(currentBusinessProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Business')),
      body: AsyncView(
        value: business,
        onRetry: () => ref.invalidate(myBusinessesProvider),
        builder: (b) {
          if (b == null) {
            return ListView(
              padding: const EdgeInsets.only(bottom: Gap.xxl),
              children: [
                const SizedBox(height: Gap.lg),
                const InvitationsSection(),
                SizedBox(
                  height: 380,
                  child: EmptyState(
                    icon: Icons.storefront_outlined,
                    title: 'Set up your business',
                    message: 'Register your salon to add locations, services, staff and opening hours.',
                    action: FilledButton(
                      style: FilledButton.styleFrom(minimumSize: const Size(220, 52)),
                      onPressed: () => context.push('/register'),
                      child: const Text('Register your business'),
                    ),
                  ),
                ),
              ],
            );
          }
          return RefreshIndicator(
            onRefresh: () async => refreshSetup(ref),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(bottom: Gap.xxl),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.sm, Gap.lg, Gap.lg),
                  child: ReviewStatusCard(business: b),
                ),
                const InvitationsSection(),
                const OnboardingCard(),
                const SectionHeader('Manage'),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
                  child: Card(
                    child: Column(
                      children: [
                        MenuTile(
                          icon: Icons.badge_outlined,
                          title: 'Business profile',
                          subtitle: 'Name, description and review status',
                          onTap: () => context.push('/manage/profile'),
                        ),
                        const Divider(height: 1),
                        _CountTile(
                          icon: Icons.place_outlined,
                          title: 'Locations',
                          count: ref.watch(locationsProvider).value?.length,
                          onTap: () => context.push('/manage/locations'),
                        ),
                        const Divider(height: 1),
                        _CountTile(
                          icon: Icons.content_cut_rounded,
                          title: 'Services & prices',
                          count: ref.watch(servicesProvider).value?.length,
                          onTap: () => context.push('/manage/services'),
                        ),
                        const Divider(height: 1),
                        _CountTile(
                          icon: Icons.groups_outlined,
                          title: 'Staff',
                          count: ref.watch(staffProvider).value?.length,
                          onTap: () => context.push('/manage/staff'),
                        ),
                        const Divider(height: 1),
                        MenuTile(
                          icon: Icons.rule_rounded,
                          title: 'Booking rules',
                          subtitle: 'Response time, notice and booking window',
                          onTap: () => context.push('/manage/policy'),
                        ),
                        const Divider(height: 1),
                        MenuTile(
                          icon: Icons.account_balance_outlined,
                          title: 'Bank account',
                          subtitle: 'Where your earnings are paid',
                          onTap: () => context.push('/earnings/bank-account'),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _CountTile extends StatelessWidget {
  const _CountTile({required this.icon, required this.title, required this.count, required this.onTap});

  final IconData icon;
  final String title;
  final int? count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) =>
      MenuTile(icon: icon, title: title, subtitle: count == null ? null : (count == 0 ? 'None yet' : '$count'), onTap: onTap);
}
