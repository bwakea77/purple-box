// Metro configuration for Expo
// Fixes Windows crashes when Metro tries to watch/remove Android native build folders (e.g. android/app/.cxx).
const { getDefaultConfig } = require('expo/metro-config');
const exclusionList = require('metro-config/src/defaults/exclusionList');

const config = getDefaultConfig(__dirname);

config.resolver.blockList = exclusionList([
  /android\/app\/\.cxx\/.*/,
  /android\/app\/build\/.*/,
  /android\/build\/.*/,
  /android\/\.gradle\/.*/,
]);

module.exports = config;

