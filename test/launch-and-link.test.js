const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLaunchUri, classifyJoinIntent } = require('../src/main/launch-uri');
const { parsePrivateServerLink } = require('../src/main/private-link');

test('builds modern launch URIs for matchmaking and exact public servers', () => {
  assert.equal(buildLaunchUri({ placeId: '1818' }), 'roblox://experiences/start?placeId=1818');
  assert.equal(buildLaunchUri({ placeId: '1818', gameInstanceId: 'f5b4b707-d397-4c6d-8484-50847584c1b8' }), 'roblox://experiences/start?placeId=1818&gameInstanceId=f5b4b707-d397-4c6d-8484-50847584c1b8');
  assert.equal(buildLaunchUri({ placeId: '1818', linkCode: 'a+b/c' }), 'roblox://experiences/start?placeId=1818&linkCode=a%2Bb%2Fc');
});

test('builds the documented legacy direct-link fallback', () => {
  assert.equal(buildLaunchUri({ placeId: '1818', accessCode: 'secret' }, 'legacy'), 'roblox://placeId=1818&accessCode=secret');
});

test('builds the official-style private-list handoff without a share code', () => {
  assert.equal(
    buildLaunchUri({ placeId: '1818', joinAttemptId: 'f5b4b707-d397-4c6d-8484-50847584c1b8', joinAttemptOrigin: 'privateServerListJoin' }),
    'roblox://experiences/start?placeId=1818&joinAttemptId=f5b4b707-d397-4c6d-8484-50847584c1b8&joinAttemptOrigin=privateServerListJoin'
  );
});

test('classifies mutually exclusive join selectors', () => {
  assert.equal(classifyJoinIntent({ placeId: '1818' }), 'matchmaking');
  assert.equal(classifyJoinIntent({ placeId: '1818', gameInstanceId: 'f5b4b707-d397-4c6d-8484-50847584c1b8' }), 'exact-public');
  assert.equal(classifyJoinIntent({ placeId: '1818', linkCode: 'a-code' }), 'private-link');
  assert.equal(classifyJoinIntent({ placeId: '1818', joinAttemptId: 'f5b4b707-d397-4c6d-8484-50847584c1b8' }), 'private-server');
  assert.throws(() => classifyJoinIntent({ placeId: '1818', linkCode: 'a-code', accessCode: 'b-code' }), /conflicting/);
});

test('parses Roblox share links without navigating to them', () => {
  const parsed = parsePrivateServerLink('https://www.roblox.com/share?code=abc-123_XY&type=Server');
  assert.deepEqual(parsed, {
    kind: 'linkCode', code: 'abc-123_XY', placeId: undefined, gameInstanceId: undefined, userId: undefined, ignoredKeys: []
  });
});

test('parses deep-link private codes and IDs', () => {
  const parsed = parsePrivateServerLink('https://www.roblox.com/games/start?placeId=1818&privateServerLinkCode=abc123');
  assert.equal(parsed.kind, 'linkCode');
  assert.equal(parsed.code, 'abc123');
  assert.equal(parsed.placeId, '1818');
});

test('parses modern and legacy roblox: deep links', () => {
  const modern = parsePrivateServerLink('roblox://experiences/start?placeId=1818&linkCode=abc123');
  assert.equal(modern.placeId, '1818');
  assert.equal(modern.code, 'abc123');
  const legacy = parsePrivateServerLink('roblox://placeId=1818&accessCode=secret');
  assert.equal(legacy.placeId, '1818');
  assert.equal(legacy.kind, 'accessCode');
});

test('rejects non-Roblox URLs and non-server share links', () => {
  assert.throws(() => parsePrivateServerLink('https://evil.example/share?code=abc&type=Server'), /Only HTTPS Roblox links/);
  assert.throws(() => parsePrivateServerLink('https://www.roblox.com/share?code=abc&type=Experience'), /does not contain/);
  assert.throws(() => parsePrivateServerLink('not a code with spaces'), /private-server link or code/);
});
