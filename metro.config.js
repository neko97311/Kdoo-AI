const { getDefaultConfig } = require('expo/metro-config');
const { withNativewind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
// Monorepo root: two levels up from projects/app
const monorepoRoot = path.resolve(projectRoot, '../..');

let config = getDefaultConfig(projectRoot);

// Monorepo support: tell Metro where to find dependencies. With pnpm's
// non-hoisted layout, transitive deps live under node_modules/.pnpm/<pkg>@ver/
// node_modules/, which Metro only discovers via hierarchical lookup from
// the resolved module's location — so disableHierarchicalLookup must stay
// false here.
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules/.pnpm'),
];

config = withNativewind(config);

// Ensure `.web.tsx` / `.web.js` platform extensions are resolved.
// Expo SDK 56's getDefaultConfig only registers ["ios","android"] in
// resolver.platforms, so without "web" here the bundler ignores .web.*
// files and falls back to .native.* — breaking markdown/image rendering.
if (!config.resolver.platforms.includes('web')) {
  config.resolver.platforms = [...config.resolver.platforms, 'web'];
}

// Fix Hermes native stack overflow
// Expo SDK 56 defaults inlineRequires to `false`, which causes ALL static
// imports to be eagerly evaluated during module initialization. With 2000+
// modules, the require() chain overflows Hermes' native stack in
// interpreter mode (Expo Go).
//
// Enabling inlineRequires defers require() calls to their point of first
// use, drastically reducing eager evaluation depth.
// See: node_modules/@expo/metro-config/build/ExpoMetroConfig.js line 326
const origTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (entryFiles, options, ...rest) => {
  // Pass through to get the Expo defaults first
  const result = await origTransformOptions();

  // inlineRequires causes issues with lazy getters in react-native
  // (e.g. FlatList) in the SSR bundle for web. Only enable for native
  // platforms (ios/android) to prevent Hermes stack overflow from
  // eager evaluation of 2000+ modules.
  const platform = options?.platform;
  const inlineRequires = platform && platform !== 'web';

  return {
    ...result,
    transform: {
      ...result.transform,
      inlineRequires,
    },
  };
};

module.exports = config;
