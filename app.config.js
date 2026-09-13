const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Config plugin: disables PNG crunching / WebP auto-conversion during the
 * Android release build. Without this, Metro generates BOTH a .png copy AND
 * a .webp version of every image asset, and Android's resource merger throws
 * "Duplicate resources" because both map to the same drawable resource ID.
 */
const withNoWebpConversion = (config) => {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;

    // Guard: only inject once
    if (contents.includes('cruncherEnabled = false')) return mod;

    // Insert aaptOptions block right after `android {`
    contents = contents.replace(
      /android\s*\{/,
      `android {\n    aaptOptions {\n        cruncherEnabled = false\n    }\n`
    );

    mod.modResults.contents = contents;
    return mod;
  });
};

// Pull in everything from app.json and apply the plugin
const appJson = require('./app.json');

module.exports = ({ config }) => {
  const merged = {
    ...appJson.expo,
    plugins: [
      ...(appJson.expo.plugins || []),
    ],
  };

  return withNoWebpConversion(merged);
};
