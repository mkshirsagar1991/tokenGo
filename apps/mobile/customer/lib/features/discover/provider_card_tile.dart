import 'package:flutter/material.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// One nearby provider in the results list: the things a customer compares — distance, price, rating, open now.
class ProviderCardTile extends StatelessWidget {
  const ProviderCardTile({super.key, required this.card, required this.onTap});

  final ProviderCard card;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(Gap.lg),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(color: c.primaryContainer, borderRadius: BorderRadius.circular(Corners.md)),
                alignment: Alignment.center,
                child: Text(
                  card.name.isEmpty ? '?' : card.name[0].toUpperCase(),
                  style: t.textTheme.headlineSmall?.copyWith(color: c.onPrimaryContainer, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: Gap.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            card.name,
                            style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        StatusPill(card.openNow ? 'Open now' : 'Closed', tone: card.openNow ? Tone.success : Tone.neutral),
                      ],
                    ),
                    const SizedBox(height: Gap.xs),
                    Text(
                      card.address.oneLine,
                      style: t.textTheme.bodyMedium?.copyWith(color: c.onSurfaceVariant),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: Gap.md),
                    Wrap(
                      spacing: Gap.lg,
                      runSpacing: Gap.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        if (card.distanceLabel.isNotEmpty) _Fact(icon: Icons.near_me_outlined, text: card.distanceLabel),
                        if (card.priceFrom != null) _Fact(icon: Icons.sell_outlined, text: 'from ${card.priceFrom!.format()}'),
                        _Fact(
                          icon: Icons.star_rounded,
                          text: card.rating.hasRatings ? '${card.rating.average!.toStringAsFixed(1)} (${card.rating.count})' : 'New',
                          iconColor: card.rating.hasRatings ? const Color(0xFFF5A623) : c.outline,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.text, this.iconColor});

  final IconData icon;
  final String text;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: iconColor ?? t.colorScheme.onSurfaceVariant),
        const SizedBox(width: Gap.xs),
        Text(text, style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurface)),
      ],
    );
  }
}
