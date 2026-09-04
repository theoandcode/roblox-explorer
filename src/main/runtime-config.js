const path = require('node:path');

function readPackagedDefaults() {
  try {
    const packageMetadata = require(path.resolve(__dirname, '../../package.json'));
    const defaults = packageMetadata?.robloxExplorerDefaults;
    return defaults && typeof defaults === 'object' ? defaults : {};
  } catch {
    return {};
  }
}

const packagedDefaults = readPackagedDefaults();

function getRuntimeDefault(name) {
  const value = packagedDefaults[name];
  return typeof value === 'string' ? value : undefined;
}

module.exports = { getRuntimeDefault };
