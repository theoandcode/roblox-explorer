#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

const targets = {
  mac: ['--mac'],
  darwin: ['--mac'],
  win: ['--win'],
  windows: ['--win'],
  win32: ['--win'],
  linux: ['--linux'],
  current: [{ darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform] || '--dir'],
  all: ['--mac', '--win', '--linux']
};

function usage() {
  console.log('Usage: node scripts/build.js [--mac|--win|--linux|--all|--current] [electron-builder options]');
  console.log('Examples: npm run build:mac, npm run build:win, npm run build:linux, npm run build:all');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

let targetArgs;
const passthrough = [];
for (const arg of args) {
  const name = arg.replace(/^--/, '').toLowerCase();
  if (!targetArgs && targets[name]) targetArgs = targets[name];
  else passthrough.push(arg);
}
if (!targetArgs) targetArgs = targets.current;

const binaryName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
const binaryPath = path.join(projectRoot, 'node_modules', '.bin', binaryName);
if (!fs.existsSync(binaryPath)) {
  console.error('electron-builder is not installed. Run npm install first.');
  process.exit(1);
}

const builderConfigPath = path.join(projectRoot, 'electron-builder.config.js');
if (!fs.existsSync(builderConfigPath)) {
  console.error('electron-builder.config.js is missing.');
  process.exit(1);
}

console.log(`Building ${targetArgs.join(' ')}…`);

const hasCustomConfig = passthrough.some((arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg.startsWith('-c='));
const configArgs = hasCustomConfig ? [] : ['--config', builderConfigPath];
const result = spawnSync(binaryPath, [...configArgs, ...targetArgs, ...passthrough], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit'
});
if (result.error) {
  console.error(`Build failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
