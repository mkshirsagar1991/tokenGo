import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

/// What happened inside the payment provider's checkout, AS THE CHECKOUT REPORTS IT. This is only a hint for the screen:
/// money is credited solely when the SERVER has confirmed the payment with the provider (see TopUpSheet).
sealed class CheckoutOutcome {
  const CheckoutOutcome();
}

class CheckoutCompleted extends CheckoutOutcome {
  const CheckoutCompleted();
}

class CheckoutCancelled extends CheckoutOutcome {
  const CheckoutCancelled();
}

class CheckoutFailed extends CheckoutOutcome {
  const CheckoutFailed(this.message);
  final String message;
}

/// Opens a payment provider's checkout. An interface so tests (and other providers) can stand in for Razorpay.
abstract interface class CheckoutLauncher {
  Future<CheckoutOutcome> open({required String keyId, required String orderId, required String description});
}

/// Razorpay's native Android/iOS checkout (TEST mode while the server is configured with test keys).
class RazorpayCheckoutLauncher implements CheckoutLauncher {
  @override
  Future<CheckoutOutcome> open({required String keyId, required String orderId, required String description}) {
    final done = Completer<CheckoutOutcome>();
    final razorpay = Razorpay();

    void finish(CheckoutOutcome outcome) {
      if (!done.isCompleted) done.complete(outcome);
    }

    razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse _) => finish(const CheckoutCompleted()));
    razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse r) {
      if (r.code == Razorpay.PAYMENT_CANCELLED) {
        finish(const CheckoutCancelled());
      } else {
        finish(CheckoutFailed(r.message ?? 'The payment did not go through.'));
      }
    });
    // A wallet app (e.g. Paytm, PhonePe) took over: the result will reach the server, which is the only source of truth.
    razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, (ExternalWalletResponse _) => finish(const CheckoutCompleted()));

    try {
      razorpay.open({
        'key': keyId,
        'order_id': orderId, // the amount comes from the server-created order, never from the app
        'name': 'TokenGo',
        'description': description,
        'timeout': 600,
        'theme': {'color': '#4F46E5'},
        'retry': {'enabled': true, 'max_count': 2},
        'send_sms_hash': false,
      });
    } catch (e) {
      finish(const CheckoutFailed('Could not open the payment screen.'));
    }
    return done.future.whenComplete(razorpay.clear);
  }
}

final checkoutLauncherProvider = Provider<CheckoutLauncher>((ref) => RazorpayCheckoutLauncher());
