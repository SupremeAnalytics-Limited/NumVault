/**
 * Expo config plugin: disableSentryAutoUpload
 *
 * Problem
 * -------
 * @sentry/react-native ships a React Native Gradle plugin that registers
 * a `createBundleReleaseJsAndAssets_SentryUpload_<pkg>_<versionCode>` task
 * which tries to run sentry-cli for source-map uploads. On the OnSpace build
 * server sentry-cli is not installed, so the task crashes the build with:
 *   "A problem occurred starting process 'command '.../sentry-cli'"
 *
 * Confirmed failing task name from build log (v2 did NOT disable it):
 *   createBundleReleaseJsAndAssets_SentryUpload_ng.numvault.app@3.0.0+...
 *
 * Why v2 failed
 * -------------
 * v2 injected only `tasks.whenTaskAdded { ... }`. That hook fires only for
 * tasks registered AFTER the hook itself is registered. The Sentry React
 * Native Gradle plugin applies during its own plugin application phase —
 * which happens before app/build.gradle's appended block runs. By the time
 * `whenTaskAdded` is registered, the SentryUpload task already exists.
 * Gradle's `whenTaskAdded` callback is therefore NEVER invoked for it.
 *
 * Fix (v3)
 * --------
 * Three complementary mechanisms, each targeting a different registration
 * window, so the SentryUpload task cannot survive any of them:
 *
 * 1. tasks.whenTaskAdded  — catches any SentryUpload task added AFTER our
 *    hook is registered (future-proofs against plugin ordering changes).
 *
 * 2. afterEvaluate + tasks.configureEach — runs AFTER all plugins have
 *    applied and all tasks are registered; iterates the complete task graph
 *    and disables every task whose name contains 'SentryUpload'.
 *
 * 3. afterEvaluate + explicit finalizedBy removal — finds
 *    createBundleReleaseJsAndAssets and strips any SentryUpload entry from
 *    its finalizedBy dependencies so even a disabled task cannot gate the
 *    bundle step.
 *
 * No `sentry {}` DSL block is used. The Sentry Android Gradle plugin
 * (io.sentry.android.gradle) is NOT applied in this project — using its
 * DSL would cause "Could not find method sentry()" errors.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GUARD = 'disableSentryAutoUpload_v3';

const GRADLE_BLOCK = `
// ── disableSentryAutoUpload_v3 ───────────────────────────────────────────────
// Disables ALL Sentry source-map / symbol upload tasks.
// sentry-cli is not available on the OnSpace build server.
//
// Three mechanisms target different task registration windows:
//
//  1) whenTaskAdded     – fires for tasks registered after this hook
//  2) afterEvaluate     – fires after all plugins apply; configureEach
//                         iterates the complete, already-built task graph
//  3) finalizedBy strip – removes SentryUpload from the bundle task's
//                         finalizedBy chain so it cannot gate the build

// Mechanism 1: future task registrations
tasks.whenTaskAdded { task ->
    if (task.name.contains('SentryUpload') || task.name.toLowerCase().contains('sentryupload')) {
        task.enabled = false
        println "disableSentryAutoUpload[whenTaskAdded]: disabled \${task.name}"
    }
}

// Mechanisms 2 + 3: tasks already registered by the time this block runs
afterEvaluate {
    // Disable every SentryUpload task in the graph
    tasks.configureEach { task ->
        if (task.name.contains('SentryUpload') || task.name.toLowerCase().contains('sentryupload')) {
            task.enabled = false
            println "disableSentryAutoUpload[afterEvaluate]: disabled \${task.name}"
        }
    }

    // Remove SentryUpload entries from the bundle task's finalizedBy chain
    // so a disabled-but-still-wired task cannot block the release build.
    def bundleTaskNames = [
        'createBundleReleaseJsAndAssets',
        'bundleReleaseJsAndAssets',
        'createBundleDebugJsAndAssets',
    ]
    bundleTaskNames.each { taskName ->
        def bundleTask = tasks.findByName(taskName)
        if (bundleTask) {
            def sentryDeps = bundleTask.finalizedBy.getDependencies(bundleTask).findAll { dep ->
                dep.name.contains('SentryUpload') || dep.name.toLowerCase().contains('sentryupload')
            }
            sentryDeps.each { dep ->
                bundleTask.finalizedBy.getDependencies(bundleTask).remove(dep)
                println "disableSentryAutoUpload[afterEvaluate]: removed finalizedBy \${dep.name} from \${taskName}"
            }
        }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

module.exports = function disableSentryAutoUpload(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency: skip if v3 already injected
    if (gradle.includes(GUARD)) {
      return mod;
    }

    // Remove v1 (wrong sentry{} DSL block) and v2 (whenTaskAdded-only) injections
    const cleaned = gradle
      .replace(/\/\/ ── disableSentryAutoUpload_v1[\s\S]*?\/\/ ─+\n/, '')
      .replace(/\/\/ ── disableSentryAutoUpload_v2[\s\S]*?\/\/ ─+\n/, '');

    // Append after the closing brace of the android {} block
    mod.modResults.contents = cleaned.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_BLOCK}`
    );

    return mod;
  });
};
