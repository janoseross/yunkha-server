const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { setup } = require('./helpers.cjs');

const clientPath = join(process.env.YUNKHA_MOBILE_ROOT ?? join(homedir(), 'projects/yunkha'), 'src/services/signaling/signalingClient.ts');

test('unchanged mobile SignalingClient connects using only a supplied URL', {
  skip: !existsSync(clientPath) && 'Optional sibling mobile repository is unavailable',
}, async (t) => {
  const { url, connect, join: joinRoom } = await setup(t);
  // Compile the actual sibling source in memory, without editing either client.
  // Node 22 supplies the same browser WebSocket API used by this wrapper.
  const output = ts.transpileModule(readFileSync(clientPath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const compiled = { exports: {} };
  new Function('exports', output)(compiled.exports);
  const { SignalingClient } = compiled.exports;
  const messages = [];
  const failures = [];
  let resolveOpen;
  const opened = new Promise((resolve) => { resolveOpen = resolve; });
  const client = new SignalingClient(url, {
    onOpen: () => resolveOpen(),
    onMessage: (message) => messages.push(message),
    onClose: (reason) => failures.push(reason),
    onError: () => failures.push('socket error'),
    onInvalidMessage: () => failures.push('invalid message'),
  });
  t.after(() => client.close());
  await opened;
  assert.equal(client.isOpen, true);
  const camera = {
    async next() {
      for (let i = 0; i < 300; i += 1) {
        if (messages.length) return messages.shift();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Mobile client did not receive a response');
    },
    async expect(message) { assert.deepEqual(await this.next(), message); },
  };
  client.send({ type: 'create-room' });
  const created = await camera.next();
  assert.equal(created.type, 'room-created');
  await camera.expect({ type: 'waiting' });
  const monitor = await connect();
  await joinRoom(monitor, camera, created.code);
  const offer = { type: 'offer', callId: 'mobile-client', sdp: { type: 'offer', sdp: 'offer' } };
  client.send(offer);
  await monitor.expect(offer);
  const answer = { type: 'answer', callId: 'mobile-client', sdp: { type: 'answer', sdp: 'answer' } };
  monitor.send(answer);
  await camera.expect(answer);
  client.send({ type: 'leave-room' });
  await monitor.expect({ type: 'room-ended', code: created.code });
  assert.deepEqual(failures, []);
});
