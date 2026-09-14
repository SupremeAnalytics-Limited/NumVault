/**
 * Expo config plugin: fixMetroCompat
 *
 * Root Cause
 * ----------
 * The build server resolves metro-config to an older version (pre-0.73) whose
 * src/defaults/defaults.js file requires several internal Metro paths that were
 * removed or reorganised in Metro 0.73+:
 *
 *   require('metro/src/lib/createModuleIdFactory')  → removed in Metro 0.73
 *   require('metro/src/lib/getMaxWorkers')           → removed in Metro 0.73
 *
 * This is a Node.js-level require that executes before Metro ever reads
 * metro.config.js, so resolver.extraNodeModules has no effect. Adding
 * individual shim files for each missing module just reveals the next broken
 * require in the same file on the next build.
 *
 * Fix (v3)
 * --------
 * Patch metro-config/src/defaults/defaults.js itself — replacing every broken
 * internal require() with an inline implementation — in a single Gradle task
 * that runs before createBundleReleaseJsAndAssets spawns the Node process.
 * Handles both single-quote and double-quote forms of the require paths.
 * Idempotent: a guard comment prevents double-patching on cached build servers.
 */

const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', {
    paths: [require.resolve('expo/package.json').replace('/package.json', '')],
  })
);

const GUARD = 'fixMetroCompat_v3';

const GRADLE_TASK = `
// ── fixMetroCompat_v3 ────────────────────────────────────────────────────────
// Patches metro-config/src/defaults/defaults.js to remove broken requires for
// internal Metro APIs (createModuleIdFactory, getMaxWorkers) that were removed
// in Metro 0.73+.  Runs before createBundleReleaseJsAndAssets so the Node
// process that spawns the bundler never hits MODULE_NOT_FOUND.
tasks.register('fixMetroCompat') {
    doFirst {
        def projectDir = rootProject.projectDir.parentFile

        // metro-config may sit directly in node_modules or be hoisted —
        // check both locations used by npm and pnpm.
        def candidates = [
            new File(projectDir, "node_modules/metro-config/src/defaults/defaults.js"),
            new File(projectDir, "node_modules/.pnpm/metro-config@0.72.3/node_modules/metro-config/src/defaults/defaults.js"),
        ]

        def target = candidates.find { it.exists() }
        if (target == null) {
            // Try a glob-style search one level deeper for pnpm version variants
            def pnpmDir = new File(projectDir, "node_modules/.pnpm")
            if (pnpmDir.exists()) {
                pnpmDir.listFiles()?.each { versionDir ->
                    if (versionDir.name.startsWith("metro-config@")) {
                        def candidate = new File(versionDir, "node_modules/metro-config/src/defaults/defaults.js")
                        if (candidate.exists() && target == null) {
                            target = candidate
                        }
                    }
                }
            }
        }

        if (target == null) {
            println "fixMetroCompat: defaults.js not found — skipping patch"
            return
        }

        def content = target.text

        // Idempotency: skip if already patched
        if (content.contains("fixMetroCompat_v3")) {
            println "fixMetroCompat: defaults.js already patched — skipping"
            return
        }

        println "fixMetroCompat: patching \${target}"

        // ── createModuleIdFactory ─────────────────────────────────────────────
        // Replaced with an inline factory that assigns stable numeric IDs to
        // module paths — identical behaviour to the original implementation.
        def idFactoryInline = """(function(){
  var _fileToIdMap = new Map();
  var _nextId = 0;
  return function(path) {
    var id = _fileToIdMap.get(path);
    if (typeof id !== 'number') { id = _nextId++; _fileToIdMap.set(path, id); }
    return id;
  };
})"""
        content = content
            .replace("require('metro/src/lib/createModuleIdFactory')", idFactoryInline)
            .replace('require("metro/src/lib/createModuleIdFactory")', idFactoryInline)

        // ── getMaxWorkers ─────────────────────────────────────────────────────
        // Replaced with an inline implementation that mirrors the original:
        // use the provided value or fall back to half the CPU count.
        def maxWorkersInline = """(function(){
  try { var os = require('os'); } catch(e) { var os = {cpus: function(){return [];}}; }
  return function(w) {
    if (w != null && w > 0) return Number(w);
    var cpus = os.cpus ? os.cpus().length : 1;
    return Math.max(1, Math.ceil(cpus / 2));
  };
})()"""
        content = content
            .replace("require('metro/src/lib/getMaxWorkers')", maxWorkersInline)
            .replace('require("metro/src/lib/getMaxWorkers")', maxWorkersInline)

        // Prepend a guard comment so idempotency check works on next run
        content = "// fixMetroCompat_v3\\n" + content

        target.text = content
        println "fixMetroCompat: patch applied successfully to \${target}"
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

    // Idempotency guard — skip if v3 already injected
    if (gradle.includes(GUARD)) {
      return mod;
    }

    // Remove any v1 or v2 injection so we don't accumulate stale blocks
    const cleaned = gradle
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
