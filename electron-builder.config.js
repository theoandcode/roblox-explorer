const { normalizeAuthProxy } = require('./src/main/auth-proxy');

// dotenv-cli runs electron-builder as a child process, so the selected build
// environment is available while this configuration is evaluated. Only the
// validated, non-secret proxy endpoint is copied into the packaged metadata;
// the environment file itself is never included in the app.
const configuredProxy = process.env.ROBLOX_NAVIGATOR_AUTH_PROXY;
const normalizedProxy = configuredProxy ? normalizeAuthProxy(configuredProxy) || '' : '';

module.exports = {
  appId: 'com.roblox.explorer',
  productName: 'Roblox Explorer',
  asar: true,
  directories: {
    output: 'dist'
  },
  files: [
    'src/**/*',
    'avatar.jpeg',
    'package.json',
    '!test{,/**/*}',
    '!scripts{,/**/*}',
    '!README.md',
    '!app-and-api-integration.md'
  ],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      }
    ],
    category: 'public.app-category.games'
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64']
      }
    ]
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64', 'arm64']
      },
      {
        target: 'deb',
        arch: ['x64', 'arm64']
      }
    ],
    category: 'Game'
  },
  extraMetadata: {
    robloxExplorerDefaults: {
      authProxy: normalizedProxy
    }
  }
};
