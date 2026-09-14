/**
 * Expo config plugin: disableSentryAutoUpload
 *
 * Problem
 * -------
 * @sentry/react-native ships a Gradle plugin that auto-registers a
 * `createBundleReleaseJsAndAssets_SentryUpload_*` task which tries to run
 * sentry-cli for source-map / ProGuard / native-symbol uploads.
 * On the OnSpace build server sentry-cli is not installed, so the task
 * crashes the build with:
 *   "A problem occurred starting process 'command '.../sentry-cli'"
 *
 * The environment variable SENTRY_DISABLE_AUTO_UPLOAD is already set as a
 * Cloud Secret but there is no sentry.gradle in this project (the Expo
 * Sentry config-plugin was intentionally removed), so the variable is
 * never read and the upload task still runs.
 *
 * Fix
 * ---
 * Inject a `sentry { ... }` DSL block into app/build.gradle immediately
 * after the `android { }` close.  This is the canonical way to disable
 * Sentry's Gradle upload tasks without touching the Sentry SDK itself.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GUARD = 'disableSentryAutoUpload_v1';

const GRADLE_BLOCK = `
// ── disableSentryAutoUpload_v1 ───────────────────────────────────────────────
// Disables sentry-cli source-map / ProGuard / native-symbol upload tasks.
// sentry-cli is not available on the OnSpace build server, and uploads are
// handled manually via sentry-cli after builds complete.
sentry {
    autoUploadProguardMapping = false
    uploadNativeSymbols = false
    autoInstallation {
        enabled = false
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

module.exports = function disableSentryAutoUpload(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency guard — only inject once
    if (gradle.includes(GUARD)) {
      return mod;
    }

    // Append after the closing brace of the android {} block
    mod.modResults.contents = gradle.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_BLOCK}`
    );

    return mod;
  });
};
