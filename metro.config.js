const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// PERMANENT FIX: Block the old onboarding1/2/3 image filenames from ever
// being resolved by Metro, regardless of whether they physically exist on
// the build server's filesystem or in its Metro cache. The build server at
// /tmp/rn-app-tem/ retains a stale snapshot that still has these files on
// disk; Metro bundles them and Android's resource merger then sees both the
// .png and .webp variants as duplicate resources. blockList intercepts
// resolution before any file-system or cache lookup, so it is immune to
// server-side cache staleness.
config.resolver.blockList = [
  /.*assets[/\\]images[/\\]onboarding[123]\.(png|webp|jpg|jpeg)$/,
];

config.cacheVersion = 'nv-build-v11';

module.exports = config;
