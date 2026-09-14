const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Increment this string whenever a build server cache issue needs busting
// (e.g. stale Sentry Metro serializer injection from a removed plugin).
config.cacheVersion = 'numvault-clean-v2';

module.exports = config;
