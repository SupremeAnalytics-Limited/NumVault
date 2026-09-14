/**
 * Expo config plugin: fixMetroCompat
 *
 * Root Cause
 * ----------
 * The build server resolves metro-config to an older version (pre-0.73) whose
 * src/defaults/index.js (and src/defaults/defaults.js) files require several
 * internal Metro paths that were removed or reorganised in Metro 0.73+:
 *
 *   require('metro/src/lib/createModuleIdFactory')  → removed in Metro 0.73
 *   require('metro/src/lib/getMaxWorkers')           → removed in Metro 0.73
 *
 * The confirmed failing file from the build log is:
 *   metro-config/src/defaults/index.js
 *
 * This is a Node.js-level require that executes before Metro ever reads
 * metro.config.js, so resolver.extraNodeModules has no effect. Adding
 * individual shim files for each missing module just reveals the next broken
 * require in the same file on the next build.
 *
 * Fix (v4)
 * --------
 * Patch BOTH metro-config/src/defaults/index.js AND defaults.js — replacing
 * every broken internal require() with an inline implementation — in a single
 * Gradle task that runs before createBundleReleaseJsAndAssets spawns the Node
 * process. Handles both single-quote and double-quote forms of the require
 * paths. Idempotent: a guard comment prevents double-patching.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GUARD = 'fixMetroCompat_v4';

const GRADLE_TASK = `
// ── fixMetroCompat_v4 ────────────────────────────────────────────────────────
// Patches metro-config/src/defaults/index.js (confirmed failing file) and
// src/defaults/defaults.js (belt-and-suspenders) to remove broken requires
// for internal Metro APIs removed in Metro 0.73+:
//   createModuleIdFactory, getMaxWorkers
// Runs before createBundleReleaseJsAndAssets so the Node process that spawns
// the bundler never hits MODULE_NOT_FOUND.
tasks.register('fixMetroCompat') {
    doFirst {
        def projectDir = rootProject.projectDir.parentFile

        // ── Inline replacement strings ────────────────────────────────────────
        // createModuleIdFactory: assigns stable numeric IDs to module paths.
        def idFactoryInline = """(function(){
  var _fileToIdMap = new Map();
  var _nextId = 0;
  return function(path) {
    var id = _fileToIdMap.get(path);
    if (typeof id !== 'number') { id = _nextId++; _fileToIdMap.set(path, id); }
    return id;
  };
})"""

        // getMaxWorkers: use provided value or half the CPU count.
        def maxWorkersInline = """(function(){
  try { var os = require('os'); } catch(e) { var os = {cpus: function(){return [];}}; }
  return function(w) {
    if (w != null && w > 0) return Number(w);
    var cpus = os.cpus ? os.cpus().length : 1;
    return Math.max(1, Math.ceil(cpus / 2));
  };
})()"""

        // ── Helper: patch a single file ───────────────────────────────────────
        def patchFile = { File f ->
            if (!f.exists()) return
            def content = f.text
            if (content.contains("fixMetroCompat_v4")) {
                println "fixMetroCompat: \${f.name} already patched — skipping"
                return
            }
            println "fixMetroCompat: patching \${f}"
            content = content
                .replace("require('metro/src/lib/createModuleIdFactory')", idFactoryInline)
                .replace('require("metro/src/lib/createModuleIdFactory")', idFactoryInline)
                .replace("require('metro/src/lib/getMaxWorkers')", maxWorkersInline)
                .replace('require("metro/src/lib/getMaxWorkers")', maxWorkersInline)
            content = "// fixMetroCompat_v4\\n" + content
            f.text = content
            println "fixMetroCompat: patch applied to \${f.name}"
        }

        // ── Locate metro-config (npm flat layout) ─────────────────────────────
        def defaultsRoot = new File(projectDir, "node_modules/metro-config/src/defaults")
        if (defaultsRoot.exists()) {
            patchFile(new File(defaultsRoot, "index.js"))    // confirmed failing file
            patchFile(new File(defaultsRoot, "defaults.js")) // belt-and-suspenders
        }

        // ── Locate metro-config (pnpm content-addressable layout) ─────────────
        def pnpmDir = new File(projectDir, "node_modules/.pnpm")
        if (pnpmDir.exists()) {
            pnpmDir.listFiles()?.each { versionDir ->
                if (versionDir.name.startsWith("metro-config@")) {
                    def root = new File(versionDir, "node_modules/metro-config/src/defaults")
                    if (root.exists()) {
                        patchFile(new File(root, "index.js"))
                        patchFile(new File(root, "defaults.js"))
                    }
                }
            }
        }
    }
}

tasks.whenTaskAdded { task ->
    if (task.name == 'createBundleReleaseJsAndAssets' ||
        task.name == 'bundleReleaseJsAndAssets'       ||
        task.name == 'createBundleDebugJsAndAssets') {
        task.dependsOn 'fixMetroCompat'
    }
}
// ─────────────────────────────────────────────────────────────────────────────
`;

module.exports = function fixMetroCompat(config) {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;

    // Idempotency guard — skip if v4 already injected
    if (gradle.includes(GUARD)) {
      return mod;
    }

    // Remove any v1/v2/v3 injections so we don't accumulate stale blocks
    const cleaned = gradle
      .replace(/\/\/ ── fixMetroCompat_v3[\s\S]*?\/\/ ─+\n/, '')
      .replace(/\/\/ ── fixMetroModuleIdFactory_v2[\s\S]*?\/\/ ─+\n/, '')
      .replace(/\/\/ ── fixMetroModuleIdFactory_v1[\s\S]*?\/\/ ─+\n/, '');

    // Append after the closing brace of the android {} block
    mod.modResults.contents = cleaned.replace(
      /^(android \{[\s\S]*?\n\})/m,
      `$1\n${GRADLE_TASK}`
    );

    return mod;
  });
};
