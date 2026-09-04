/*
 * Electron's package postinstall can be skipped by managed npm settings, and
 * older extract-zip releases can fail to finish on newer Node versions. Keep
 * the project runnable by repairing the local Electron artifact from the
 * official @electron/get cache when its launcher metadata or binary is absent.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadArtifact } = require('@electron/get');

const electronRoot = path.resolve(__dirname, '..', 'node_modules', 'electron');
const electronPackage = require(path.join(electronRoot, 'package.json'));
const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const platformPath = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe'
}[platform];

if (!platformPath) {
  console.warn(`Electron artifact repair is not configured for ${platform}; skipping.`);
  process.exit(0);
}

const pathFile = path.join(electronRoot, 'path.txt');
const executable = path.join(electronRoot, 'dist', platformPath);
let currentPath;
try { currentPath = fs.readFileSync(pathFile, 'utf8'); } catch { currentPath = undefined; }
if (currentPath === platformPath && fs.existsSync(executable)) process.exit(0);
if (fs.existsSync(executable)) {
  if (platform !== 'win32') fs.chmodSync(executable, 0o755);
  fs.writeFileSync(pathFile, platformPath);
  process.exit(0);
}

async function repair() {
  const checksumsPath = path.join(electronRoot, 'checksums.json');
  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    platform,
    arch,
    checksums: fs.existsSync(checksumsPath) ? require(checksumsPath) : undefined
  });
  const distPath = path.join(electronRoot, 'dist');
  fs.mkdirSync(distPath, { recursive: true });
  const command = platform === 'win32' ? 'tar' : 'unzip';
  const args = platform === 'win32'
    ? ['-xf', zipPath, '-C', distPath]
    : ['-q', '-o', zipPath, '-d', distPath];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${command} exited with status ${result.status}`);
  }
  if (!fs.existsSync(executable)) throw new Error(`Electron executable was not extracted to ${executable}`);
  if (platform !== 'win32') fs.chmodSync(executable, 0o755);
  fs.writeFileSync(pathFile, platformPath);
}

repair().catch((error) => {
  console.error(`Electron artifact repair failed: ${error.message}`);
  process.exitCode = 1;
});
