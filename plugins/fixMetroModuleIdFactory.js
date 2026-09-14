/**
 * Expo config plugin: fixMetroModuleIdFactory
 *
 * Problem
 * -------
 * `metro/src/lib/createModuleIdFactory` was removed in Metro 0.73+, but
 * the build server's version of metro-config (loaded by @expo/cli at
 * startup) still does:
 *
 *   require('metro/src/lib/createModuleIdFactory')
 *
 * This is a **Node.js-level require** that happens before Metro ever reads
 * metro.config.js, so resolver.extraNodeModules has no effect whatsoever.
 *
 * Fix
 * ---
 * Inject a Gradle task that writes the shim file directly to the physical
 * path  node_modules/metro/src/lib/createModuleIdFactory.js  before the
 * createBundleReleaseJsAndAssets task spawns the node process.
 *
 * Because this runs after every `npm install` (Gradle is invoked after
 * dependency installation) and recreates the file on every build, it
 * survives fresh installs on the build server.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GRADLE_TASK = `
// ── fixMetroModuleIdFactory_v2 ──────────────────────────────────────────────
// metro/src/lib/createModuleIdFactory was removed in Metro 0.73+ but an older
// metro-config pulled in by @expo/cli still requires it at Node.js startup —
// before Metro ever reads metro.config.js (so resolver.extraNodeModules is
// irrelevant).  This task writes the shim at the real node_modules path so
// Node's native require() resolution finds it before the bundler is spawned.
tasks.register('fixMetroModuleIdFactory') {
    doFirst {
        def projectDir = rootProject.projectDir.parentFile
        def shimDir = new File(projectDir, "node_modules/metro/src/lib")
        def shimFile = new File(shimDir, "createModuleIdFactory.js")
        if (!shimFile.exists()) {
            shimDir.mkdirs()
            shimFile.text = """'use strict';
/**
 * Shim: metro/src/lib/createModuleIdFactory
 * Removed in Metro 0.73+. Re-created by fixMetroModuleIdFactory Gradle plugin.
 */
function createModuleIdFactory() {
  var fileToIdMap = new Map();
  var nextId = 0;
  return function(path) {
    var id = fileToIdMap.get(path);
    if (typeof id !== 'number') {
      id = nextId++;
      fileToIdMap.set(path, id);
    }
    return id;
  };
}
module.exports = createModuleIdFactory;
"""
            println "fixMetroModuleIdFactory: wrote shim to \${shimFile}"
        } else {
            println "fixMetroModuleIdFactory: shim already present at \${shimFile}"
        }
    }
}

tasks.whenTaskAdded { task ->
    if (task.name == 'createBundleReleaseJsAndAssets' ||
        task.name == 'bundleReleaseJsAndAssets' ||
        task.name == 'createBundleDebugJsAndAssets') {
        task.dependsOn 'fixMetroModuleIdFactory'
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

const GUARD = 'fixMetroModuleIdFactory_v2';

module.exports = function fixMetroModuleIdFactory(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency guard — only inject once (v2 = after android{} not inside it)
    if (gradle.includes(GUARD + '_v2')) {
      return mod;
    }

    mod.modResults.contents = gradle.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_TASK}`
    );

    return mod;
  });
};
