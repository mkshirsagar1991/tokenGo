import 'package:flutter/foundation.dart';

import 'json_helpers.dart';

/// The caller's own profile. The phone number arrives MASKED — the server never returns it in full.
@immutable
class UserProfile {
  const UserProfile({required this.id, required this.phoneMasked, required this.permissions});

  factory UserProfile.fromJson(Map<String, dynamic> j) =>
      UserProfile(id: j.s('id'), phoneMasked: j.s('phone_masked'), permissions: j.ls('permissions'));

  final String id;
  final String phoneMasked;
  final List<String> permissions;

  bool can(String permission) => permissions.contains(permission);
}
