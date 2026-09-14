// cache-bust: nv-build-10
module.exports = function (api) {
  api.cache.invalidate(() => 'nv-build-10');
  return {
    presets: ['babel-preset-expo'],
  };
};
