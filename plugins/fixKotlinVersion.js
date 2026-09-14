/**
 * Expo config plugin: fixKotlinVersion
 *
 * Root Cause
 * ----------
 * The build server's project-level build.gradle sets an old ext.kotlinVersion
 * (typically 1.6.x or 1.7.x) that pre-dates the Kotlin sources shipped inside
 * expo-modules-core 2.x (Expo SDK 53). When Gradle compiles :expo-modules-core
 * with the wrong Kotlin plugin version, compileKotlin either fails silently or
 * produces no .class files for the expo.modules.kotlin.* package. The Java
 * compiler then runs and cannot find any of those classes, producing:
 *
 *   :expo-modules-core:compileReleaseJavaWithJavac
 *   error: cannot find symbol — class/package expo.modules.kotlin.*
 *
 * This error is NOT a missing npm dependency. The classes exist in the Kotlin
 * sources inside node_modules/expo-modules-core/android/. The problem is
 * purely that the wrong Kotlin toolchain compiled (or failed to compile) them.
 *
 * Required Kotlin Version
 * -----------------------
 * Expo SDK 53 / React Native 0.79.x ships with:
 *   - expo-modules-core 2.x  → requires Kotlin ≥ 1.9.23
 *   - React Native 0.79      → uses Kotlin 2.0.21 in its own Gradle scripts
 *   - New Architecture (Fabric/JSI) → additional Kotlin codegen
 *
 * Setting kotlinVersion = '2.0.21' in ext ensures every subproject (including
 * :expo-modules-core) compiles its Kotlin sources with the correct toolchain.
 *
 * Fix (v1)
 * --------
 * 1. withProjectBuildGradle — injects or overwrites ext.kotlinVersion in the
 *    top-level build.gradle so ALL subprojects inherit the correct value.
 * 2. withAppBuildGradle — ensures kotlin-android plugin is applied to :app
 *    (required for New Architecture / TurboModules interop) and sets an
 *    explicit jvmTarget so Kotlin output is compatible with the Java version
 *    the build server uses.
 *
 * Idempotency: each injection is guarded by a unique marker string so
 * re-running prebuild never double-injects.
 */

const { withProjectBuildGradle, withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

// ── Versions ──────────────────────────────────────────────────────────────────
// Kotlin 2.0.21 is what React Native 0.79.x ships with and what
// expo-modules-core 2.x (Expo SDK 53) requires for correct compilation.
const KOTLIN_VERSION = '2.0.21';

const PROJECT_GUARD = 'fixKotlinVersion_v1_project';
const APP_GUARD     = 'fixKotlinVersion_v1_app';

// ── Project-level build.gradle patch ─────────────────────────────────────────
// Inserted once inside the `buildscript { ext { ... } }` block.
// If an existing kotlinVersion line is present it is replaced; otherwise the
// block is injected so that Kotlin plugin classpath declaration picks it up.
function patchProjectBuildGradle(contents) {
  if (contents.includes(PROJECT_GUARD)) return contents;

  // Case 1: an existing kotlinVersion = '...' line exists — replace it
  if (/kotlinVersion\s*=/.test(contents)) {
    return contents
      .replace(
        /kotlinVersion\s*=\s*['"][^'"]*['"]/g,
        `kotlinVersion = '${KOTLIN_VERSION}'`
      )
      // Append guard on the same line so idempotency check works
      .replace(
        new RegExp(`kotlinVersion = '${KOTLIN_VERSION}'(?! // ${PROJECT_GUARD})`),
        `kotlinVersion = '${KOTLIN_VERSION}' // ${PROJECT_GUARD}`
      );
  }

  // Case 2: buildscript { ext { } } exists — inject inside it
  if (/buildscript\s*\{[\s\S]*?ext\s*\{/.test(contents)) {
    return contents.replace(
      /(buildscript\s*\{[\s\S]*?ext\s*\{)/,
      `$1\n        kotlinVersion = '${KOTLIN_VERSION}' // ${PROJECT_GUARD}`
    );
  }

  // Case 3: buildscript { } exists but no ext { } — inject ext block
  if (/buildscript\s*\{/.test(contents)) {
    return contents.replace(
      /(buildscript\s*\{)/,
      `$1\n    ext {\n        kotlinVersion = '${KOTLIN_VERSION}' // ${PROJECT_GUARD}\n    }`
    );
  }

  // Case 4: no buildscript block at all — prepend at the top
  return (
    `// ${PROJECT_GUARD}\n` +
    `buildscript { ext { kotlinVersion = '${KOTLIN_VERSION}' } }\n\n` +
    contents
  );
}

// ── App-level build.gradle patch ──────────────────────────────────────────────
// Ensures kotlin-android is applied and sets compileOptions + kotlinOptions
// so Kotlin/Java bytecode targets are consistent.
const APP_KOTLIN_BLOCK = `
// ── fixKotlinVersion_v1_app ──────────────────────────────────────────────────
// Apply kotlin-android plugin and enforce consistent JVM target so that
// expo-modules-core Kotlin classes are visible to compileReleaseJavaWithJavac.
// kotlinVersion in the project ext (set by fixKotlinVersion_v1_project)
// controls which Kotlin toolchain compiles all subprojects.
if (!project.plugins.hasPlugin('org.jetbrains.kotlin.android')) {
    apply plugin: 'org.jetbrains.kotlin.android'
}
android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

module.exports = function fixKotlinVersion(config) {
  // Step 1: patch project-level build.gradle (ext.kotlinVersion)
  config = withProjectBuildGradle(config, (mod) => {
    mod.modResults.contents = patchProjectBuildGradle(mod.modResults.contents);
    return mod;
  });

  // Step 2: patch app-level build.gradle (kotlin-android plugin + jvmTarget)
  config = withAppBuildGradle(config, (mod) => {
    if (mod.modResults.contents.includes(APP_GUARD)) return mod;
    mod.modResults.contents += APP_KOTLIN_BLOCK;
    return mod;
  });

  return config;
};
