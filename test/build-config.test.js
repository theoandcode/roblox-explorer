const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const configScript = "const config = require('./electron-builder.config'); process.stdout.write(JSON.stringify({ icon: config.icon, proxy: config.extraMetadata.robloxExplorerDefaults.authProxy }));";

test('uses the supplied avatar for packaged application icons', () => {
  const result = spawnSync(process.execPath, ['-e', configScript], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.icon, 'avatar.png');
  assert.equal(require('node:fs').existsSync(path.join(projectRoot, config.icon)), true);
});

test('embeds a normalized proxy endpoint in packaged metadata', () => {
  const result = spawnSync(process.execPath, ['-e', configScript], {
    cwd: projectRoot,
    env: { ...process.env, ROBLOX_NAVIGATOR_AUTH_PROXY: 'socks4://proxy.example:1080///' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).proxy, 'socks4://proxy.example:1080');
});

test('leaves the packaged proxy default empty when no proxy is configured', () => {
  const environment = { ...process.env };
  delete environment.ROBLOX_NAVIGATOR_AUTH_PROXY;
  const result = spawnSync(process.execPath, ['-e', configScript], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).proxy, '');
});
