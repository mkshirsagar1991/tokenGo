import 'package:flutter/material.dart';

/// Spacing scale (logical pixels). Use these instead of ad-hoc numbers so screens stay consistent.
abstract final class Gap {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

/// Corner radii.
abstract final class Corners {
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double pill = 999;
}

/// Semantic colors that Material's scheme does not provide. Never hard-code status colors in a screen.
@immutable
class StatusColors extends ThemeExtension<StatusColors> {
  const StatusColors({
    required this.success,
    required this.successContainer,
    required this.warning,
    required this.warningContainer,
    required this.danger,
    required this.dangerContainer,
    required this.info,
    required this.infoContainer,
  });

  final Color success;
  final Color successContainer;
  final Color warning;
  final Color warningContainer;
  final Color danger;
  final Color dangerContainer;
  final Color info;
  final Color infoContainer;

  static const light = StatusColors(
    success: Color(0xFF0F7B3F),
    successContainer: Color(0xFFD7F3E0),
    warning: Color(0xFF8A5A00),
    warningContainer: Color(0xFFFFEBC2),
    danger: Color(0xFFB3261E),
    dangerContainer: Color(0xFFFBDAD7),
    info: Color(0xFF1B5FAA),
    infoContainer: Color(0xFFD9E8FA),
  );

  static const dark = StatusColors(
    success: Color(0xFF7EDBA1),
    successContainer: Color(0xFF0F3D22),
    warning: Color(0xFFFFC857),
    warningContainer: Color(0xFF4A3300),
    danger: Color(0xFFFFB4AB),
    dangerContainer: Color(0xFF5C1511),
    info: Color(0xFFA8CBF5),
    infoContainer: Color(0xFF123A66),
  );

  @override
  StatusColors copyWith({
    Color? success,
    Color? successContainer,
    Color? warning,
    Color? warningContainer,
    Color? danger,
    Color? dangerContainer,
    Color? info,
    Color? infoContainer,
  }) => StatusColors(
    success: success ?? this.success,
    successContainer: successContainer ?? this.successContainer,
    warning: warning ?? this.warning,
    warningContainer: warningContainer ?? this.warningContainer,
    danger: danger ?? this.danger,
    dangerContainer: dangerContainer ?? this.dangerContainer,
    info: info ?? this.info,
    infoContainer: infoContainer ?? this.infoContainer,
  );

  @override
  StatusColors lerp(ThemeExtension<StatusColors>? other, double t) {
    if (other is! StatusColors) return this;
    return StatusColors(
      success: Color.lerp(success, other.success, t)!,
      successContainer: Color.lerp(successContainer, other.successContainer, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningContainer: Color.lerp(warningContainer, other.warningContainer, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      dangerContainer: Color.lerp(dangerContainer, other.dangerContainer, t)!,
      info: Color.lerp(info, other.info, t)!,
      infoContainer: Color.lerp(infoContainer, other.infoContainer, t)!,
    );
  }
}

extension StatusColorsX on BuildContext {
  StatusColors get statusColors => Theme.of(this).extension<StatusColors>() ?? StatusColors.light;
}

/// One theme for every TokenGo app; each app passes its own [seed] so they stay recognisably related but distinct.
abstract final class TokenGoTheme {
  static const customerSeed = Color(0xFF4F46E5);
  static const providerSeed = Color(0xFF0E7C86);

  static ThemeData light({Color seed = customerSeed}) => _build(Brightness.light, seed, StatusColors.light);
  static ThemeData dark({Color seed = customerSeed}) => _build(Brightness.dark, seed, StatusColors.dark);

  static ThemeData _build(Brightness brightness, Color seed, StatusColors status) {
    final scheme = ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
    final base = ThemeData(colorScheme: scheme, useMaterial3: true, visualDensity: VisualDensity.standard);
    return base.copyWith(
      extensions: [status],
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(
        centerTitle: false,
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        titleTextStyle: base.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Corners.lg),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(Corners.md), borderSide: BorderSide.none),
        contentPadding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.md),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Corners.md)),
          textStyle: base.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Corners.md)),
        ),
      ),
      chipTheme: base.chipTheme.copyWith(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Corners.pill)),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surfaceContainer,
        indicatorColor: scheme.primaryContainer,
        labelTextStyle: WidgetStatePropertyAll(base.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Corners.md)),
      ),
    );
  }
}
