import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import '../business/business_state.dart';
import 'earnings_state.dart';

/// Where earnings are paid. The account is checked with the bank before anything is sent to it, the number is never shown
/// again in full, and the name must match the business's — all enforced by the server; this form only helps fill it in.
class BankAccountScreen extends ConsumerStatefulWidget {
  const BankAccountScreen({super.key});

  @override
  ConsumerState<BankAccountScreen> createState() => _BankAccountScreenState();
}

class _BankAccountScreenState extends ConsumerState<BankAccountScreen> {
  final _form = GlobalKey<FormState>();
  final _holder = TextEditingController();
  final _number = TextEditingController();
  final _confirm = TextEditingController();
  final _ifsc = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_holder, _number, _confirm, _ifsc]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save(ProviderAccount business) async {
    if (!(_form.currentState?.validate() ?? false) || _saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref
          .read(providerRepositoryProvider)
          .setPayoutAccount(business.id, holderName: _holder.text, accountNumber: _number.text, ifsc: _ifsc.text);
      refreshEarnings(ref);
      if (!mounted) return;
      showSnack(context, 'Saved. We will verify the account with your bank before paying anything to it.');
      context.pop();
    } catch (e) {
      if (mounted) setState(() => _error = errorMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final business = ref.watch(currentBusinessProvider).value;
    final current = ref.watch(earningsProvider).value?.account;
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Bank account')),
      body: business == null
          ? const BrandLoader()
          : ListView(
              padding: const EdgeInsets.all(Gap.lg),
              children: [
                if (current != null)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(Gap.lg),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Current account', style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                          Text(
                            '${current.holderName}\n${current.accountMasked} · ${current.ifsc}',
                            style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: Gap.sm),
                          Text(
                            'Entering new details replaces it. A changed account is verified again, and payouts pause for a short safety wait.',
                            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: Gap.lg),
                Form(
                  key: _form,
                  child: Column(
                    children: [
                      TextFormField(
                        controller: _holder,
                        textCapitalization: TextCapitalization.words,
                        decoration: const InputDecoration(
                          labelText: 'Account holder name',
                          helperText: 'Exactly as it appears at the bank',
                        ),
                        validator: (v) => (v ?? '').trim().length < 2 ? 'Enter the account holder name' : null,
                      ),
                      const SizedBox(height: Gap.md),
                      TextFormField(
                        controller: _number,
                        keyboardType: TextInputType.number,
                        obscureText: true,
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
                        decoration: const InputDecoration(labelText: 'Account number'),
                        validator: (v) => RegExp(r'^\d{9,18}$').hasMatch(v ?? '') ? null : 'Enter 9 to 18 digits',
                      ),
                      const SizedBox(height: Gap.md),
                      TextFormField(
                        controller: _confirm,
                        keyboardType: TextInputType.number,
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
                        decoration: const InputDecoration(labelText: 'Re-enter account number'),
                        validator: (v) => v == _number.text ? null : 'The numbers do not match',
                      ),
                      const SizedBox(height: Gap.md),
                      TextFormField(
                        controller: _ifsc,
                        textCapitalization: TextCapitalization.characters,
                        inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[A-Za-z0-9]')), LengthLimitingTextInputFormatter(11)],
                        decoration: const InputDecoration(labelText: 'IFSC code', helperText: 'For example HDFC0001234'),
                        validator: (v) =>
                            RegExp(r'^[A-Za-z]{4}0[A-Za-z0-9]{6}$').hasMatch(v ?? '') ? null : 'Enter a valid 11-character IFSC',
                      ),
                    ],
                  ),
                ),
                if (_error != null) ...[const SizedBox(height: Gap.md), Text(_error!, style: TextStyle(color: t.colorScheme.error))],
                const SizedBox(height: Gap.xl),
                FilledButton(
                  onPressed: _saving ? null : () => _save(business),
                  child: _saving
                      ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                      : const Text('Save bank account'),
                ),
              ],
            ),
    );
  }
}
