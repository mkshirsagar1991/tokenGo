/// Turning what a person types ("₹1,250.50") into integer paise, and back — WITHOUT floating point. `0.29 * 100` is
/// `28.999999999999996` in IEEE-754; a price must never be off by a paisa, so the digits are split and recombined as
/// integers (requirements §11).
abstract final class MoneyInput {
  /// The most a single service may cost (₹10,00,000, the server's own ceiling). The server re-checks.
  static const maxServiceMinor = 100000000;

  /// "200" → 20000, "1,250.5" → 125050, "₹99.99" → 9999. Returns null for anything that is not a plain non-negative amount
  /// with at most two decimals (so "1e3", "-5", "12.345", "abc", "" are all rejected rather than guessed at).
  static int? parseRupees(String input) {
    var text = input.trim();
    if (text.startsWith('₹')) text = text.substring(1).trim();
    text = text.replaceAll(',', '');
    final match = RegExp(r'^(\d{1,9})(?:\.(\d{1,2}))?$').firstMatch(text);
    if (match == null) return null;
    final whole = int.parse(match.group(1)!);
    final fraction = (match.group(2) ?? '').padRight(2, '0');
    return whole * 100 + (fraction.isEmpty ? 0 : int.parse(fraction));
  }

  /// 20000 → "200", 125050 → "1250.50" (what goes back into the text field when editing).
  static String toRupeesText(int minor) {
    final whole = minor ~/ 100;
    final fraction = minor % 100;
    return fraction == 0 ? '$whole' : '$whole.${fraction.toString().padLeft(2, '0')}';
  }
}
