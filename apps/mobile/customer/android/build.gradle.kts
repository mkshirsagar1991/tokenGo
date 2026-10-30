allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Flutter provisions an NDK for EVERY Android module, and plugin modules that do not name one get the Android Gradle
// plugin's newer default, which makes the first build download ~1.5 GB. Pin them to the same NDK as the app.
// (A plugin's own build file may set ndkVersion itself, e.g. `flutter.ndkVersion`, so this must run AFTER it evaluates.)
subprojects {
    if (name != "app" && !state.executed) {
        afterEvaluate {
            extensions.findByType<com.android.build.api.dsl.LibraryExtension>()?.ndkVersion = "27.1.12297006"
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
