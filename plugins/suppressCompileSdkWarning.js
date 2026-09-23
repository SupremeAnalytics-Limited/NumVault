/**
 * Expo config plugin: suppressCompileSdkWarning
 *
 * Google Play requires targetSdkVersion 36. Expo SDK 53 ships Android Gradle
 * Plugin 8.8, which builds fine against API 36 but stops with an "unsupported
 * compileSdk" warning unless it is told this is intended.
 */
const { withGradleProperties } = require('@expo/config-plugins');

const KEY = 'android.suppressUnsupportedCompileSdk';

module.exports = function suppressCompileSdkWarning(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((p) => !(p.type === 'property' && p.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: '36' });
    return cfg;
  });
};
