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
// ── removeStaleOnboardingAssets_v3 ─────────────────────────────────────────
// Deletes stale onboarding/slidepatterns drawable files that the build
// server's cache injects via createBundleReleaseJsAndAssets before
// mergeReleaseResources runs. Also removes any .png files with an invalid
// PNG signature (first 8 bytes) or that are suspiciously small (< 8 bytes).
tasks.register('removeStaleOnboardingAssets') {
    doLast {
        def dirs = [
            "\${buildDir}/generated/res/createBundleReleaseJsAndAssets",
            "\${buildDir}/intermediates/merged_res/release",
            "\${buildDir}/intermediates/res/merged/release",
            "\${buildDir}/intermediates/incremental/mergeReleaseResources",
        ]
        def patterns = [
            '**/assets_images_onboarding1.png',
            '**/assets_images_onboarding1.webp',
            '**/assets_images_onboarding2.png',
            '**/assets_images_onboarding2.webp',
            '**/assets_images_onboarding3.png',
            '**/assets_images_onboarding3.webp',
            '**/assets_images_slidepatterns.png',
            '**/assets_images_slidepatterns.webp',
        ]
        // PNG magic bytes: 137 80 78 71 13 10 26 10
        def PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as byte[]

        dirs.each { dir ->
            // 1. Delete known stale files by name pattern
            fileTree(dir: dir, include: patterns).each { f ->
                println "removeStaleOnboardingAssets: deleting stale file \${f}"
                f.delete()
            }

            // 2. Scan all .png files for invalid signature or tiny size
            fileTree(dir: dir, include: ['**/*.png']).each { f ->
                if (!f.exists()) return
                if (f.length() < 8) {
                    println "removeStaleOnboardingAssets: deleting corrupt PNG (too small) \${f}"
                    f.delete()
                    return
                }
                def header = new byte[8]
                def fis = new java.io.FileInputStream(f)
                try {
                    fis.read(header)
                } finally {
                    fis.close()
                }
                def valid = true
                for (int i = 0; i < 8; i++) {
                    if ((header[i] & 0xFF) != (PNG_SIGNATURE[i] & 0xFF)) {
                        valid = false
                        break
                    }
                }
                if (!valid) {
                    println "removeStaleOnboardingAssets: deleting corrupt PNG (bad signature) \${f}"
                    f.delete()
                }
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
    if (gradle.includes('removeStaleOnboardingAssets_v3')) {
      return mod;
    }

    // Append before the last closing brace of the android {} block
    mod.modResults.contents = gradle.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_TASK}`
    );

    return mod;
  });
};
