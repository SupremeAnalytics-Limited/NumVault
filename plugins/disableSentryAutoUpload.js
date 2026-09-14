/**
 * Expo config plugin: disableSentryAutoUpload
 *
 * Problem
 * -------
 * @sentry/react-native ships a React Native Gradle plugin that auto-registers
 * a `createBundleReleaseJsAndAssets_SentryUpload_*` task which tries to run
 * sentry-cli for source-map uploads. On the OnSpace build server sentry-cli
 * is not installed, so the task crashes the build with:
 *   "A problem occurred starting process 'command '.../sentry-cli'"
 *
 * Previous attempt injected a `sentry { ... }` DSL block intended for the
 * Android Sentry Gradle plugin (io.sentry.android.gradle), but that plugin
 * is NOT applied in this project. Only the React Native Gradle plugin is
 * active, and it does not expose a `sentry {}` extension — so Gradle threw:
 *   "Could not find method sentry() for arguments ... on project ':app'"
 *
 * Fix
 * ---
 * Inject a `tasks.whenTaskAdded` hook that sets `enabled = false` on any task
 * whose name contains 'SentryUpload'. This directly targets the problematic
 * task without requiring any specific Gradle plugin extension to be present.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GUARD = 'disableSentryAutoUpload_v2';

const GRADLE_BLOCK = `
// ── disableSentryAutoUpload_v2 ───────────────────────────────────────────────
// Disables Sentry source-map / symbol upload tasks.
// sentry-cli is not available on the OnSpace build server; uploads are
// handled manually via sentry-cli after builds complete.
// Uses tasks.whenTaskAdded (no plugin extension required) to directly disable
// any SentryUpload task registered by @sentry/react-native's Gradle plugin.
tasks.whenTaskAdded { task ->
    if (task.name.contains('SentryUpload')) {
        task.enabled = false
        println "disableSentryAutoUpload: disabled task \${task.name}"
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

    // Remove any leftover v1 injection (wrong sentry{} DSL block)
    const cleaned = gradle.replace(
      /\/\/ ── disableSentryAutoUpload_v1[\s\S]*?\/\/ ─+\n/,
      ''
    );

    // Append after the closing brace of the android {} block
    mod.modResults.contents = cleaned.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_BLOCK}`
    );

    return mod;
  });
};
