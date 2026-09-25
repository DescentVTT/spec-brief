// A plugin published as ESM only: its "exports" name no "require" or
// "default" condition, so require.resolve cannot find it.
export default { name: 'esm-only', rules: [] };
