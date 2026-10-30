import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

final profileProvider = FutureProvider.autoDispose<UserProfile>((ref) {
  ref.watch(sessionUserProvider);
  return ref.watch(authRepositoryProvider).me();
});

/// Who you are, plus sign-out.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signedIn = ref.watch(sessionUserProvider) != null;
    if (!signedIn) {
      return Scaffold(
        appBar: AppBar(title: const Text('Profile')),
        body: SignInPrompt(
          title: 'Welcome to TokenGo',
          message: 'Sign in with your phone number to book, pay and follow your appointments.',
          onSignIn: () => context.push('/login'),
        ),
      );
    }
    final profile = ref.watch(profileProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
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
                    child: Icon(Icons.person_rounded, color: t.colorScheme.onPrimaryContainer, size: 30),
                  ),
                  const SizedBox(width: Gap.lg),
                  Expanded(
                    child: profile.when(
                      loading: () => const LinearProgressIndicator(),
                      error: (e, _) => Text(errorMessage(e)),
                      data: (p) => Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(p.phoneMasked, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                          Text('Customer account', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: Gap.lg),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.account_balance_wallet_outlined),
                  title: const Text('Wallet'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.go('/wallet'),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.event_note_outlined),
                  title: const Text('My bookings'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.go('/bookings'),
                ),
              ],
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
                    content: const Text('You can sign back in any time with a code sent to your phone.'),
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
            child: Text('TokenGo · test mode', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.outline)),
          ),
        ],
      ),
    );
  }
}
