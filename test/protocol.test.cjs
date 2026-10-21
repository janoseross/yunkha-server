const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { setup } = require('./helpers.cjs');

const roomError = (reason) => ({ type: 'room-error', reason });

test('creation/join ordering, normalization, full rooms and membership error precedence', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  const extra = await connect();
  await camera.quiet(); // No greeting or server-assigned role on connection.
  const code = await create(camera);
  camera.send({ type: 'create-room' });
  await camera.expect(roomError('already-in-room'));
  camera.send({ type: 'join-room', code: '!' });
  await camera.expect(roomError('already-in-room'));
  await join(monitor, camera, code, `  ${code.toLowerCase()}\n`);
  monitor.send({ type: 'create-room' });
  await monitor.expect(roomError('already-in-room'));
  monitor.send({ type: 'join-room', code });
  await monitor.expect(roomError('already-in-room'));
  extra.send({ type: 'join-room', code });
  await extra.expect(roomError('room-full'));
});

test('invalid codes, absent rooms and leave outside a room', async (t) => {
  const { connect } = await setup(t);
  const client = await connect();
  for (const code of [undefined, null, 1234, {}, [], '', 'ABC', 'ABCDE', 'AB2C', 'AIOC', 'AB C']) {
    client.send({ type: 'join-room', code });
    await client.expect(roomError('invalid-room-code'));
  }
  client.send({ type: 'join-room', code: 'AAAA' });
  await client.expect(roomError('room-not-found'));
  client.send({ type: 'leave-room' });
  await client.expect(roomError('not-in-room'));
});

test('malformed JSON/envelopes, unknown types and binary JSON preserve legacy behavior', async (t) => {
  const { connect, create } = await setup(t);
  const client = await connect();
  for (const text of ['{', '', 'undefined', '[']) {
    client.socket.send(text);
    await client.expect({ type: 'error', message: 'Invalid JSON' });
  }
  for (const message of [null, true, 1, 'string', [], {}, { type: 1 }, { type: null }]) {
    client.send(message);
    await client.expect({ type: 'error', message: 'Invalid message' });
  }
  client.send({ type: 'unknown' });
  await client.quiet();
  client.socket.send(Buffer.from('{"type":"create-room"}'));
  assert.equal((await client.next()).type, 'room-created');
  await client.expect({ type: 'waiting' });
  client.send({ type: 'leave-room' });
  await create(client); // Invalid input did not damage the connection.
});

test('SDP, ICE and extra fields forward unchanged only to the current peer', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  const cameraB = await connect();
  const monitorB = await connect();
  await join(monitor, camera, await create(camera));
  await join(monitorB, cameraB, await create(cameraB));
  const offer = { type: 'offer', callId: 'call-1', sdp: { type: 'offer', sdp: 'v=0\r\n' }, extension: { opaque: true } };
  camera.send(offer);
  await monitor.expect(offer);
  const answer = { type: 'answer', callId: 'call-1', sdp: { type: 'answer', sdp: 'answer' } };
  monitor.send(answer);
  await camera.expect(answer);
  for (const [from, to] of [[camera, monitor], [monitor, camera]]) {
    const candidate = { type: 'candidate', callId: 'call-1', candidate: { candidate: 'candidate:1', sdpMid: null, sdpMLineIndex: 0 } };
    from.send(candidate);
    await to.expect(candidate);
    // The old service is an opaque relay, not an SDP/ICE validator.
    for (const message of [{ type: 'candidate', callId: '' }, { type: 'stop', callId: 'older-call' }]) {
      from.send(message);
      await to.expect(message);
    }
  }
  for (const client of [camera, monitor, cameraB, monitorB]) await client.quiet();
});

test('wrong roles, missing callIds, unknown types and nonmembers are silently ignored', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  const outsider = await connect();
  await join(monitor, camera, await create(camera));
  camera.send({ type: 'answer', callId: 'wrong-role' });
  monitor.send({ type: 'offer', callId: 'wrong-role' });
  for (const client of [camera, monitor, outsider]) {
    for (const type of ['offer', 'answer', 'candidate', 'stop']) {
      for (const callId of [undefined, null, 10, {}]) client.send({ type, callId });
    }
    client.send({ type: 'unknown', callId: 'x' });
  }
  outsider.send({ type: 'candidate', callId: 'outsider' });
  outsider.send({ type: 'stop', callId: 'outsider' });
  for (const client of [camera, monitor, outsider]) await client.quiet();
});

test('Camera and Monitor stop only relay; Camera restarts calls without recreating the room', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  await join(monitor, camera, await create(camera));
  for (let i = 0; i < 4; i += 1) {
    const callId = `restart-${i}`;
    const offer = { type: 'offer', callId, sdp: { type: 'offer', sdp: 'restart' } };
    camera.send(offer);
    await monitor.expect(offer);
    monitor.send({ type: 'answer', callId, sdp: { type: 'answer', sdp: 'ok' } });
    await camera.expect({ type: 'answer', callId, sdp: { type: 'answer', sdp: 'ok' } });
    const [from, to] = i % 2 ? [monitor, camera] : [camera, monitor];
    from.send({ type: 'stop', callId });
    await to.expect({ type: 'stop', callId });
  }
  await camera.quiet();
  await monitor.quiet();
});

test('repeated Monitor leave/rejoin and replacement never retain old membership', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  const replacement = await connect();
  const code = await create(camera);
  for (let i = 0; i < 4; i += 1) {
    await join(monitor, camera, code);
    monitor.send({ type: 'leave-room' });
    await camera.expect({ type: 'peer-left' });
    await camera.expect({ type: 'waiting' });
    await monitor.quiet(); // Leave has no acknowledgement to the leaver.
    await join(replacement, camera, code);
    monitor.send({ type: 'candidate', callId: 'stale', candidate: {} });
    monitor.send({ type: 'leave-room' });
    await monitor.expect(roomError('not-in-room'));
    const offer = { type: 'offer', callId: `replacement-${i}` };
    camera.send(offer);
    await replacement.expect(offer);
    replacement.send({ type: 'leave-room' });
    await camera.expect({ type: 'peer-left' });
    await camera.expect({ type: 'waiting' });
    await camera.quiet();
    await replacement.quiet();
  }
  monitor.socket.close();
  await once(monitor.socket, 'close');
  await camera.quiet(); // A later close cannot emit a second peer-left.
});

test('unexpected disconnects free Monitor slots and end Camera rooms exactly once', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  const code = await create(camera);
  await join(monitor, camera, code);
  monitor.socket.terminate();
  await camera.expect({ type: 'peer-left' });
  await camera.expect({ type: 'waiting' });
  const reconnected = await connect();
  await join(reconnected, camera, code);
  camera.socket.terminate();
  await reconnected.expect({ type: 'room-ended', code });
  reconnected.send({ type: 'join-room', code });
  await reconnected.expect(roomError('room-not-found'));
  await reconnected.quiet();
  await create(reconnected); // Monitor was detached when the Camera disconnected.
});

test('Camera leave deletes rooms, frees both roles and allows connection reuse', async (t) => {
  const { connect, create, join } = await setup(t);
  const camera = await connect();
  const monitor = await connect();
  for (let i = 0; i < 5; i += 1) {
    const code = await create(camera);
    await join(monitor, camera, code);
    camera.send({ type: 'leave-room' });
    await monitor.expect({ type: 'room-ended', code });
    monitor.send({ type: 'candidate', callId: 'stale' });
    await camera.quiet();
    monitor.send({ type: 'join-room', code });
    await monitor.expect(roomError('room-not-found'));
    camera.send({ type: 'leave-room' });
    await camera.expect(roomError('not-in-room'));
  }
  const reversed = await create(monitor);
  await join(camera, monitor, reversed);
  monitor.send({ type: 'leave-room' });
  await camera.expect({ type: 'room-ended', code: reversed });
  monitor.socket.close();
  await once(monitor.socket, 'close');
  await camera.quiet();
});

test('application shutdown closes live WebSockets and releases the listening port', async (t) => {
  const { app, connect, create, shutdown } = await setup(t);
  const camera = await connect();
  await create(camera);
  const closed = once(camera.socket, 'close');
  await shutdown();
  await closed;
  assert.equal(app.getHttpServer().listening, false);
});
