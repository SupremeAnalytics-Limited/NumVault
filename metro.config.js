// cache-bust: build-v6
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Tell Metro to resolve modules only from the top-level node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
];

config.watchFolders = [projectRoot];

// Prevent Metro from following pnpm symlinks into the virtual store
// (.pnpm/…/node_modules). Without this:
//   1. Metro discovers multiple copies of packages like metro-transform-worker
//      (one via the top-level symlink, one via the store path), triggering
//      Expo's "expected one template package, found 2" error.
//   2. Relative requires inside the virtual store (e.g. ../../package.json in
//      metro/src/DeltaBundler/getTransformCacheKey.js) escape the package root
//      and cannot be resolved.
// Setting unstable_enableSymlinks to false keeps Metro inside the hoisted
// top-level node_modules, where both problems disappear.
config.resolver.unstable_enableSymlinks = false;

module.exports = config;
