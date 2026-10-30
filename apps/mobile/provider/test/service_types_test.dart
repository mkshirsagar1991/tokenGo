import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_server.dart';

/// "What kind of service is it?": every enabled category the server offers, each under its own heading, so a garage owner sees
/// Car wash and Tyre change (not just a salon's Haircut).
void main() {
  testWidgets('the kinds of service come from the server, grouped by category, so every enabled vertical can be chosen', (tester) async {
    final server = FakeServer(registered: true);
    await pumpApp(tester, server);
    await tester.tap(find.text('Business'));
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Services & prices'));
    await tapVisible(tester, find.text('Add service'));

    expect(find.text('What kind of service is it?'), findsOneWidget);
    // two categories offer kinds, so each gets a heading
    expect(find.text('Salon'), findsOneWidget);
    expect(find.text('Vehicle service'), findsOneWidget);
    for (final kind in ['Haircut', 'Facial', 'Car wash', 'Tyre change']) {
      expect(find.widgetWithText(ChoiceChip, kind), findsOneWidget, reason: '$kind is offered');
    }

    // choosing one suggests its name (never overwriting what the owner typed)
    await tapVisible(tester, find.widgetWithText(ChoiceChip, 'Tyre change'));
    expect(find.widgetWithText(TextField, 'Tyre change'), findsOneWidget);
  });
}
