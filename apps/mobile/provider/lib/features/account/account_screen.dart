import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../business/business_state.dart';

final _profileProvider = FutureProvider.autoDispose<UserProfile>((ref) {
  ref.watch(sessionUserProvider);
  return ref.watch(authRepositoryProvider).me();
});

/// Who is signed in, which business they work for, and sign-out.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(_profileProvider);
    final business = ref.watch(currentBusinessProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: ListView(
        padding: const EdgeInsets.all(Gap.lg),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(Gap.lg),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: t.colorScheme.primaryContainer,
                    child: Icon(Icons.storefront_rounded, color: t.colorScheme.onPrimaryContainer, size: 28),
                  ),
                  const SizedBox(width: Gap.lg),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          business.value?.displayName ?? 'Your business',
                          style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        if (business.value != null)
                          Text(business.value!.statusLabel, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        profile.maybeWhen(
                          data: (p) => Text(p.phoneMasked, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                          orElse: () => const SizedBox.shrink(),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: Gap.lg),
          Card(
            child: ListTile(
              leading: Icon(Icons.logout_rounded, color: t.colorScheme.error),
              title: Text(
                'Sign out',
                style: TextStyle(color: t.colorScheme.error, fontWeight: FontWeight.w600),
              ),
              onTap: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Sign out?'),
                    content: const Text('You will stop seeing new booking requests on this phone until you sign in again.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay signed in')),
                      FilledButton(
                        style: FilledButton.styleFrom(minimumSize: const Size(100, 44)),
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text('Sign out'),
                      ),
                    ],
                  ),
                );
                if (ok == true) await ref.read(authRepositoryProvider).signOut();
              },
            ),
          ),
          const SizedBox(height: Gap.xl),
          Center(
            child: Text('TokenGo Business · test mode', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.outline)),
          ),
        ],
      ),
    );
  }
}
