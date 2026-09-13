/**
 * Expo config plugin: removeStaleOnboardingAssets
 *
 * The OnSpace build server's cached project snapshot still contains
 * assets_images_onboarding1/2/3 .png and .webp files in the
 * createBundleReleaseJsAndAssets output directory. This plugin injects
 * a Gradle task that runs immediately before mergeReleaseResources and
 * deletes any matching files, preventing the duplicate-resource error.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function removeStaleOnboardingAssets(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency guard — only inject once
    if (gradle.includes('removeStaleOnboardingAssets')) {
      return mod;
    }

    const task = `
// ── removeStaleOnboardingAssets ──────────────────────────────────────────────
// Deletes stale onboarding1/2/3 drawable files that the build server's cache
// injects via createBundleReleaseJsAndAssets before mergeReleaseResources runs.
tasks.register('removeStaleOnboardingAssets') {
    doLast {
        def dirs = [
            "\${buildDir}/generated/res/createBundleReleaseJsAndAssets",
            "\${buildDir}/intermediates/merged_res/release",
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
    if (task.name == 'mergeReleaseResources') {
        task.dependsOn 'removeStaleOnboardingAssets'
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

    // Append before the last closing brace of the android {} block
    mod.modResults.contents = gradle.replace(
      /^(android \{[\s\S]*?)(\n\})\s*$/m,
      `$1\n${task}\n$2`
    );

    return mod;
  });
};
