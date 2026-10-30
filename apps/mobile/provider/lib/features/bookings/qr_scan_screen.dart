import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// Opens the scanner full-screen and returns the text of the first QR code read, or null if the person backed out.
Future<String?> openQrScanner(BuildContext context) =>
    Navigator.of(context).push<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => const QrScanScreen()));

/// What a scanned QR code may be turned into: the customer's arrival token goes to the server untouched (the server checks its
/// signature and expiry), but nothing that cannot possibly be one is sent.
String? arrivalTokenFrom(String? scanned) {
  final t = scanned?.trim();
  if (t == null || t.isEmpty || t.length > 300) return null;
  return t;
}

/// Reads the QR code on the customer's phone. The camera permission is requested by the scanner when this screen opens, i.e.
/// only after "Scan customer QR" was tapped; if it is refused the screen says so and the 6-digit code path remains.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final code in capture.barcodes) {
      final value = code.rawValue;
      if (value != null && value.trim().isNotEmpty) {
        _done = true;
        Navigator.of(context).pop(value);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('Scan customer QR'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        titleTextStyle: Theme.of(context).textTheme.titleLarge?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
        actions: [IconButton(tooltip: 'Torch', icon: const Icon(Icons.flashlight_on_outlined), onPressed: () => _controller.toggleTorch())],
      ),
      body: MobileScanner(
        controller: _controller,
        onDetect: _onDetect,
        errorBuilder: (context, error) => _ScanProblem(error: error),
        overlayBuilder: (context, constraints) => Align(
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 240,
                height: 240,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white, width: 3),
                  borderRadius: BorderRadius.circular(Corners.lg),
                ),
              ),
              const SizedBox(height: Gap.lg),
              Text(
                'Point the camera at the QR code in the customer\'s TokenGo app.',
                textAlign: TextAlign.center,
                style: t.textTheme.bodyMedium?.copyWith(color: Colors.white),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ScanProblem extends StatelessWidget {
  const _ScanProblem({required this.error});

  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    final unsupported = error.errorCode == MobileScannerErrorCode.unsupported;
    final t = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const BrandImage(BrandArt.errorQrScan, height: 96),
            const SizedBox(height: Gap.md),
            Text(
              denied
                  ? 'Camera access is off for TokenGo Business. Allow it in Settings to scan, or go back and enter the customer\'s 6-digit code.'
                  : unsupported
                  ? 'This phone cannot scan QR codes. Go back and enter the customer\'s 6-digit code.'
                  : 'The camera could not be started. Go back and enter the customer\'s 6-digit code.',
              textAlign: TextAlign.center,
              style: t.textTheme.bodyLarge?.copyWith(color: Colors.white),
            ),
            const SizedBox(height: Gap.lg),
            if (denied)
              FilledButton.tonal(
                style: FilledButton.styleFrom(minimumSize: const Size(200, 48)),
                onPressed: Geolocator.openAppSettings,
                child: const Text('Open settings'),
              ),
            const SizedBox(height: Gap.sm),
            OutlinedButton(
              style: OutlinedButton.styleFrom(minimumSize: const Size(200, 48), foregroundColor: Colors.white),
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Back'),
            ),
          ],
        ),
      ),
    );
  }
}
