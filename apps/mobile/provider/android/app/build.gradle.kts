plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.tokengo.tokengo_provider"
    compileSdk = flutter.compileSdkVersion
    // Pinned to an NDK that is already installed on dev machines/CI images rather than whatever the Flutter SDK defaults to
    // (a different default makes Gradle download a ~1.5 GB NDK on the first build).
    ndkVersion = "27.1.12297006"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.tokengo.tokengo_provider"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Some plugins (the ML Kit barcode scanner: ~14 MB) ship their native libraries for EVERY CPU type even when Flutter builds for one
    // (`--target-platform android-arm64`), and Flutter's own Gradle plugin resets `ndk.abiFilters`, so filter at packaging time instead:
    // drop the libraries of every CPU type that was NOT requested. No flag (a plain `flutter run`) keeps everything.
    val abiByPlatform = mapOf("android-arm" to "armeabi-v7a", "android-arm64" to "arm64-v8a", "android-x64" to "x86_64")
    val requestedPlatforms = (project.findProperty("target-platform") as String?)?.split(",")?.map { it.trim() }.orEmpty()
    if (requestedPlatforms.isNotEmpty()) {
        val unwanted = abiByPlatform.filterKeys { it !in requestedPlatforms }.values
        packaging {
            jniLibs {
                excludes += unwanted.map { "lib/$it/**" }
            }
        }
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // WhatsApp one-tap / zero-tap login-code autofill: ONE copy of the Android code, shared by both apps (tokengo_core/native/android).
    sourceSets {
        getByName("main") {
            java.srcDir("../../../packages/tokengo_core/native/android")
        }
    }
}

dependencies {
    // Meta's official OTP SDK (MIT). Meta deprecates the older PendingIntent handshake on 2026-10-15; this SDK is the replacement.
    implementation("com.whatsapp.otp:whatsapp-otp-android-sdk:1.0.0")
}

// Push notifications need the app's Firebase configuration (google-services.json, from the Firebase console: Project settings >
// Your apps > this package name), placed next to this file. Without it the app builds and runs normally, just without push.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
