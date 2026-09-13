const { getDefaultConfig } = require('expo/metro-config');
const { exclusionList } = require('metro-config');

const config = getDefaultConfig(__dirname);

// Block the stale onboarding1/2/3 image files that persist on the build
// server's /tmp/rn-app-tem/ snapshot. exclusionList() merges correctly with
// Metro's internal default block list — assigning a raw array directly breaks
// Metro's resolver and causes "non-zero exit value 1" on the node process.
config.resolver.blockList = exclusionList([
  /.*onboarding1\.(png|webp|jpg|jpeg)$/,
  /.*onboarding2\.(png|webp|jpg|jpeg)$/,
  /.*onboarding3\.(png|webp|jpg|jpeg)$/,
]);

module.exports = config;
