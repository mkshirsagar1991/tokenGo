import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_customer/core/router.dart';

void main() {
  group('safeReturnPath (where to go after signing in)', () {
    test('accepts places inside the app, with their query', () {
      expect(safeReturnPath('/book/loc-1?service=s-2'), '/book/loc-1?service=s-2');
      expect(safeReturnPath('/booking/abc'), '/booking/abc');
      expect(safeReturnPath('/'), '/');
    });

    test('rejects anything that could leave the app or loop back to login', () {
      expect(safeReturnPath(null), isNull);
      expect(safeReturnPath(''), isNull);
      expect(safeReturnPath('https://evil.example/phish'), isNull);
      expect(safeReturnPath('//evil.example/phish'), isNull);
      expect(safeReturnPath('javascript:alert(1)'), isNull);
      expect(safeReturnPath('/login'), isNull);
      expect(safeReturnPath('/login/verify?phone=9876543210'), isNull);
    });
  });
}
