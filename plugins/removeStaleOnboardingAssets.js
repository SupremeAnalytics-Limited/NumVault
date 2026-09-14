/**
 * Expo config plugin: removeStaleOnboardingAssets
 *
 * The OnSpace build server's cached project snapshot still contains
 * assets_images_onboarding1/2/3 .png and .webp files in the
 * createBundleReleaseJsAndAssets output directory. This plugin injects
 * a Gradle task that runs immediately before mergeReleaseResources and
 * deletes any matching files, preventing the duplicate-resource error.
 *
 * NOTE: @expo/config-plugins is resolved through the 'expo' package to avoid
 * "Cannot find module" errors in EAS cloud build environments where it may
 * not be directly importable from the project's plugins/ directory.
 */

// @expo/config-plugins ships as a dependency of the 'expo' package.
// Resolving via require.resolve ensures EAS cloud builds find it correctly
// regardless of hoisting behaviour in the node_modules tree.
const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GRADLE_TASK = `
// ── removeStaleOnboardingAssets ──────────────────────────────────────────────
// Deletes stale onboarding1/2/3 drawable files that the build server's cache
// injects via createBundleReleaseJsAndAssets before mergeReleaseResources runs.
tasks.register('removeStaleOnboardingAssets') {
    doLast {
        def dirs = [
            "\${buildDir}/generated/res/createBundleReleaseJsAndAssets",
            "\${buildDir}/intermediates/merged_res/release",
            "\${buildDir}/intermediates/res/merged/release",
            "\${buildDir}/intermediates/incremental/mergeReleaseResources",
        ]
        def patterns = [
            'assets_images_onboarding1.png',
            'assets_images_onboarding1.webp',
            'assets_images_onboarding2.png',
            'assets_images_onboarding2.webp',
            'assets_images_onboarding3.png',
            'assets_images_onboarding3.webp',
        ]
        dirs.each { dir ->
            fileTree(dir: dir, include: patterns).each { f ->
                println "removeStaleOnboardingAssets: deleting \${f}"
                f.delete()
            }
        }
    }
}

tasks.whenTaskAdded { task ->
    // Run cleanup immediately AFTER Metro generates the bundle resources,
    // so stale files are gone before mergeReleaseResources starts.
    if (task.name == 'createBundleReleaseJsAndAssets') {
        task.finalizedBy 'removeStaleOnboardingAssets'
    }
    // Belt-and-suspenders: also block merge until cleanup is done.
    if (task.name == 'mergeReleaseResources') {
        task.dependsOn 'removeStaleOnboardingAssets'
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

module.exports = function removeStaleOnboardingAssets(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency guard — only inject once
    if (gradle.includes('removeStaleOnboardingAssets')) {
      return mod;
    }

    // Append before the last closing brace of the android {} block
    mod.modResults.contents = gradle.replace(
      /^(android \{[\s\S]*?)(\n\})\s*$/m,
      `$1\n${GRADLE_TASK}\n$2`
    );

    return mod;
  });
};
