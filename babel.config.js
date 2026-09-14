// cache-bust: nv-build-9
module.exports = function (api) {
  api.cache.invalidate(() => 'nv-build-9');
  return {
    presets: ['babel-preset-expo'],
    plugins: ['@sentry/react-native/metro/transformer'],
  };
};
