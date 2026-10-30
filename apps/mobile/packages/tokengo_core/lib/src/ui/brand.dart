import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../theme/app_theme.dart';

/// Which of the two apps is running: it decides the logo, the icon and the loader artwork. The provider app overrides
/// [brandAppProvider] in its main().
enum BrandApp {
  customer('customer', 'TokenGo'),
  business('business', 'TokenGo Business');

  const BrandApp(this.fileKey, this.label);
  final String fileKey;
  final String label;
}

final brandAppProvider = Provider<BrandApp>((ref) => BrandApp.customer);

const _package = 'tokengo_core';

/// The illustrations of the brand sheet (docs/brand/brand-sheet.webp), by the names it gives them.
enum BrandArt {
  // empty states
  emptyServices('empty_services'),
  emptySalons('empty_salons'),
  emptyBookings('empty_bookings'),
  emptyWallet('empty_wallet'),
  emptyReviews('empty_reviews'),
  emptyBookingsBusiness('empty_bookings_business'),
  emptyServicesAdded('empty_services_added'),
  emptyStaff('empty_staff'),
  emptyDocuments('empty_documents'),
  emptyEarnings('empty_earnings'),
  // success
  successBooking('success_booking'),
  successPayment('success_payment'),
  successCheckin('success_checkin'),
  successReview('success_review'),
  successRefund('success_refund'),
  // error / cancel
  errorBookingCancelled('error_booking_cancelled'),
  errorPaymentFailed('error_payment_failed'),
  errorQrScan('error_qr_scan'),
  errorNoInternet('error_no_internet'),
  // loaders that are an illustration
  loaderBooking('loader_booking'),
  loaderPayment('loader_payment'),
  loaderQr('loader_qr');

  const BrandArt(this.file);
  final String file;
}

/// One illustration. Decorative: the words next to it carry the meaning, so it is hidden from screen readers.
class BrandImage extends StatelessWidget {
  const BrandImage(this.art, {super.key, this.height = 96});

  final BrandArt art;
  final double height;

  @override
  Widget build(BuildContext context) => Image.asset(
    'assets/brand/${art.file}.png',
    package: _package,
    height: height,
    fit: BoxFit.contain,
    filterQuality: FilterQuality.medium,
    excludeFromSemantics: true,
  );
}

enum BrandLogoStyle { horizontal, vertical, icon, mark }

/// The TokenGo logo of the running app (customer: blue calendar, business: orange shop front).
///
/// The wordmark is black, so on a dark surface the horizontal / vertical logos sit on a light plate (the icon and the mark are
/// colourful and work anywhere).
class BrandLogo extends ConsumerWidget {
  const BrandLogo({super.key, this.style = BrandLogoStyle.vertical, this.height = 96, this.app});

  final BrandLogoStyle style;
  final double height;

  /// Defaults to the running app ([brandAppProvider]).
  final BrandApp? app;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final BrandApp which = app ?? ref.watch(brandAppProvider);
    final file = switch (style) {
      BrandLogoStyle.horizontal => 'logo_${which.fileKey}_horizontal',
      BrandLogoStyle.vertical => 'logo_${which.fileKey}_vertical',
      BrandLogoStyle.icon => 'icon_${which.fileKey}',
      BrandLogoStyle.mark => 'mark_${which.fileKey}',
    };
    final image = Image.asset(
      'assets/brand/$file.png',
      package: _package,
      height: height,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.medium,
      semanticLabel: which.label,
    );
    final needsPlate = Theme.of(context).brightness == Brightness.dark && (style == BrandLogoStyle.horizontal || style == BrandLogoStyle.vertical);
    if (!needsPlate) return image;
    return DecoratedBox(
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(Corners.lg)),
      child: Padding(padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.md), child: image),
    );
  }
}

enum BrandLoaderKind { app, booking, payment, qr }

/// The loading screen: the app's logo mark (or the booking / payment / QR illustration) gently pulsing above three dots.
/// Stands in for a bare spinner wherever a whole screen is waiting for data. With "remove animations" on, it just sits still.
class BrandLoader extends ConsumerStatefulWidget {
  const BrandLoader({super.key, this.kind = BrandLoaderKind.app, this.message});

  final BrandLoaderKind kind;

  /// Optional line under the dots, e.g. "Placing your booking…".
  final String? message;

  @override
  ConsumerState<BrandLoader> createState() => _BrandLoaderState();
}

class _BrandLoaderState extends ConsumerState<BrandLoader> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));

  @override
  void initState() {
    super.initState();
    _c.repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.disableAnimationsOf(context);
    if (still && _c.isAnimating) _c.stop();
    final art = switch (widget.kind) {
      BrandLoaderKind.app => null,
      BrandLoaderKind.booking => BrandArt.loaderBooking,
      BrandLoaderKind.payment => BrandArt.loaderPayment,
      BrandLoaderKind.qr => BrandArt.loaderQr,
    };
    final t = Theme.of(context);
    final picture = art != null ? BrandImage(art, height: 84) : const BrandLogo(style: BrandLogoStyle.mark, height: 72);
    return Center(
      child: Semantics(
        label: widget.message ?? 'Loading',
        liveRegion: true,
        child: ExcludeSemantics(
          child: AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              final wave = still ? 0.0 : (0.5 - (_c.value - 0.5).abs()) * 2; // 0 → 1 → 0 across one cycle
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Transform.scale(scale: 0.94 + 0.06 * wave, child: Opacity(opacity: 0.8 + 0.2 * wave, child: picture)),
                  if (art == null) ...[
                    const SizedBox(height: Gap.lg),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (var i = 0; i < 3; i++)
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4),
                            child: Opacity(
                              opacity: still ? 1 : 0.3 + 0.7 * _dot(i),
                              child: Container(width: 9, height: 9, decoration: BoxDecoration(color: t.colorScheme.primary, shape: BoxShape.circle)),
                            ),
                          ),
                      ],
                    ),
                  ],
                  if (widget.message != null) ...[
                    const SizedBox(height: Gap.md),
                    Text(widget.message!, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  /// 0..1: dot [i] is brightest when the cycle is a third of the way further along than the previous one.
  double _dot(int i) {
    final phase = (_c.value - i / 3) % 1.0;
    return phase < 0.33 ? 1.0 : (1 - (phase - 0.33) / 0.67).clamp(0.0, 1.0);
  }
}
