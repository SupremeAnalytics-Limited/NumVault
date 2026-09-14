/**
 * Shim for metro/src/lib/createModuleIdFactory
 *
 * This module was removed from Metro in 0.73+ but older versions of
 * metro-config (pulled in by the build server's @expo/cli) still require it.
 *
 * The implementation is identical to the original Metro source:
 * https://github.com/facebook/metro/blob/v0.72.x/packages/metro/src/lib/createModuleIdFactory.js
 *
 * This shim is wired in via metro.config.js resolver.extraNodeModules so that
 * any require('metro/src/lib/createModuleIdFactory') resolves here instead of
 * failing with MODULE_NOT_FOUND.
 */

'use strict';

/**
 * Creates a factory function that assigns stable numeric IDs to module paths.
 * Each unique absolute path gets a monotonically-increasing integer, starting
 * from 0.  The same path always receives the same ID within a single build.
 *
 * @returns {function(string): number}
 */
function createModuleIdFactory() {
  const fileToIdMap = new Map();
  let nextId = 0;
  return function (path) {
    let id = fileToIdMap.get(path);
    if (typeof id !== 'number') {
      id = nextId++;
      fileToIdMap.set(path, id);
    }
    return id;
  };
}

module.exports = createModuleIdFactory;
