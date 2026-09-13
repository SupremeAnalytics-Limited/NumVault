const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Force Metro to discard its entire file-map and resolution cache.
// This is the only reliable way to evict stale onboarding1/2/3 asset
// entries that persist in Metro's server-side cache between builds.
config.cacheVersion = 'nv-build-v10';

module.exports = config;
