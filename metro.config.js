const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Block stale onboarding1/2/3 image files that persist on the build server's
// /tmp/rn-app-tem/ snapshot. A single RegExp is accepted by Metro's blockList
// across all versions — exclusionList() was removed in newer Metro releases.
config.resolver.blockList = /.*onboarding[123]\.(png|webp|jpg|jpeg)$/;

module.exports = config;
