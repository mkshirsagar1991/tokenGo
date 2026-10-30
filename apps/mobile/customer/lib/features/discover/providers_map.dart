import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../config/app_config.dart';
import 'provider_card_tile.dart';

/// Map-first discovery (requirements §33): every result as a pin with its starting price; tap a pin for the card.
class ProvidersMap extends StatefulWidget {
  const ProvidersMap({super.key, required this.cards, required this.center, required this.onOpen});

  final List<ProviderCard> cards;
  final LatLng center;
  final void Function(ProviderCard card) onOpen;

  @override
  State<ProvidersMap> createState() => _ProvidersMapState();
}

class _ProvidersMapState extends State<ProvidersMap> {
  final _controller = MapController();
  ProviderCard? _selected;

  @override
  void didUpdateWidget(covariant ProvidersMap old) {
    super.didUpdateWidget(old);
    if (old.center != widget.center) {
      _selected = null;
      _controller.move(widget.center, 12.5);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Stack(
      children: [
        FlutterMap(
          mapController: _controller,
          options: MapOptions(
            initialCenter: widget.center,
            initialZoom: 12.5,
            minZoom: 4,
            maxZoom: 18,
            onTap: (_, _) => setState(() => _selected = null),
          ),
          children: [
            TileLayer(urlTemplate: AppConfig.mapTileUrl, userAgentPackageName: AppConfig.mapUserAgentPackage),
            MarkerLayer(
              markers: [
                // The place being searched around.
                Marker(
                  point: widget.center,
                  width: 22,
                  height: 22,
                  child: Container(
                    decoration: BoxDecoration(
                      color: scheme.primary,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 3),
                      boxShadow: const [BoxShadow(blurRadius: 6, color: Colors.black26)],
                    ),
                  ),
                ),
                for (final c in widget.cards)
                  Marker(
                    point: LatLng(c.latitude, c.longitude),
                    width: 92,
                    height: 52,
                    alignment: Alignment.topCenter,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => setState(() => _selected = c),
                      child: _PricePin(label: c.priceFrom?.format() ?? c.name, selected: _selected?.locationId == c.locationId),
                    ),
                  ),
              ],
            ),
            const SimpleAttributionWidget(source: Text('© OpenStreetMap contributors')),
          ],
        ),
        if (_selected != null)
          Positioned(
            left: Gap.lg,
            right: Gap.lg,
            bottom: Gap.lg,
            child: ProviderCardTile(card: _selected!, onTap: () => widget.onOpen(_selected!)),
          ),
      ],
    );
  }
}

class _PricePin extends StatelessWidget {
  const _PricePin({required this.label, required this.selected});

  final String label;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.xs + 1),
          decoration: BoxDecoration(
            color: selected ? c.primary : c.surface,
            borderRadius: BorderRadius.circular(Corners.pill),
            border: Border.all(color: c.primary, width: 1.5),
            boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black26)],
          ),
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(color: selected ? c.onPrimary : c.primary, fontWeight: FontWeight.w800),
          ),
        ),
        Icon(Icons.arrow_drop_down, size: 22, color: c.primary),
      ],
    );
  }
}
