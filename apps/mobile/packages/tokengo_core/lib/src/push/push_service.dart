import 'package:flutter_riverpod/flutter_riverpod.dart';

/// A push notification as the apps see it. `data` is what the SERVER put in the message (ids and the notification kind): the
/// text shown to the person is never used to decide anything.
class PushMessage {
  const PushMessage({this.title, this.body, this.data = const {}});

  final String? title;
  final String? body;
  final Map<String, String> data;

  /// The booking this notification is about, if any.
  String? get bookingId => _nonEmpty(data['booking_id']);

  /// What happened, e.g. BOOKING_CONFIRMED, WALLET_CREDITED, PAYOUT_PAID (set by the server).
  String get kind => data['kind'] ?? '';

  static String? _nonEmpty(String? v) => v == null || v.isEmpty ? null : v;
}

/// Where push notifications come from. The real one is Firebase Cloud Messaging ([FirebasePushService]); everywhere else
/// (tests, a build without a Firebase configuration, iPhone for now) it is [NoPushService] and the apps simply have no push.
abstract class PushService {
  /// Gets push ready (and asks for the notification permission). False means "no push on this phone": that is normal and
  /// never an error the person needs to see.
  Future<bool> start();

  /// This phone's push address, or null if there is none.
  Future<String?> token();

  /// Fires when the push address changed and must be sent to the server again.
  Stream<String> get tokenRefreshed;

  /// A notification that arrived while the app was open (the system shows nothing then).
  Stream<PushMessage> get foreground;

  /// A notification the person tapped while the app was in the background.
  Stream<PushMessage> get opened;

  /// The notification that started the app from closed, if the person tapped one. Returned once.
  Future<PushMessage?> initialMessage();

  /// Forgets this phone's push address, so the next person to sign in gets a new one.
  Future<void> deleteToken();
}

class NoPushService implements PushService {
  const NoPushService();

  @override
  Future<bool> start() async => false;
  @override
  Future<String?> token() async => null;
  @override
  Stream<String> get tokenRefreshed => const Stream.empty();
  @override
  Stream<PushMessage> get foreground => const Stream.empty();
  @override
  Stream<PushMessage> get opened => const Stream.empty();
  @override
  Future<PushMessage?> initialMessage() async => null;
  @override
  Future<void> deleteToken() async {}
}

/// Each app's main() overrides this with a [FirebasePushService].
final pushServiceProvider = Provider<PushService>((ref) => const NoPushService());
