const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Increment this string whenever a build server cache issue needs busting
// (e.g. stale Sentry Metro serializer injection from a removed plugin).
config.cacheVersion = 'numvault-clean-v4';

// ── Compatibility shim ────────────────────────────────────────────────────────
// metro/src/lib/createModuleIdFactory was removed in Metro 0.73+, but the
// build server's version of metro-config still requires it at startup.
// extraNodeModules is a plain alias map (not a custom resolver function) so
// it does not affect the hermesc serializer chain.
config.resolver = config.resolver ?? {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  'metro/src/lib/createModuleIdFactory': path.resolve(
    __dirname,
    'shims/metro-createModuleIdFactory.js',
  ),
};
// ─────────────────────────────────────────────────────────────────────────────

module.exports = config;
