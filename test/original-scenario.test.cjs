// Ported from yunkha/scripts/signaling-server.test.cjs; only server lifecycle/port changed.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WebSocket } = require('ws');
const { createApplication } = require('../dist/main');

test('rooms isolate signaling and clean up when peers leave', async () => {
  const app = await createApplication(false);
  await app.listen(0, '127.0.0.1');
  const port = app.getHttpServer().address().port;
  const sockets = [];

  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const client = {
      socket,
      messages,
      send: (message) => socket.send(JSON.stringify(message)),
      async next(type) {
        for (let i = 0; i < 100; i += 1) {
          const index = messages.findIndex((message) => message.type === type);
          if (index >= 0) return messages.splice(index, 1)[0];
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Missing ${type}: ${JSON.stringify(messages)}`);
      },
    };
    sockets.push(client);
    return client;
  }

  try {
    const cameraA = await connect();
    const cameraB = await connect();
    const monitorA = await connect();
    const monitorB = await connect();
    const extra = await connect();

    cameraA.send({ type: 'create-room' });
    const codeA = (await cameraA.next('room-created')).code;
    assert.match(codeA, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    await cameraA.next('waiting');
    cameraB.send({ type: 'create-room' });
    const codeB = (await cameraB.next('room-created')).code;
    assert.notEqual(codeA, codeB);
    await cameraB.next('waiting');

    monitorA.send({ type: 'join-room', code: codeA.toLowerCase() });
    assert.equal((await monitorA.next('room-joined')).code, codeA);
    await monitorA.next('ready');
    await cameraA.next('ready');
    monitorB.send({ type: 'join-room', code: codeB });
    await monitorB.next('room-joined');
    await monitorB.next('ready');
    await cameraB.next('ready');

    extra.send({ type: 'join-room', code: codeA });
    assert.equal((await extra.next('room-error')).reason, 'room-full');
    extra.send({ type: 'join-room', code: 'AB2C' });
    assert.equal((await extra.next('room-error')).reason, 'invalid-room-code');
    extra.send({ type: 'join-room', code: 'AIOC' });
    assert.equal((await extra.next('room-error')).reason, 'invalid-room-code');
    const missingCode = ['AAAA', 'BBBB', 'CCCC'].find((code) => code !== codeA && code !== codeB);
    extra.send({ type: 'join-room', code: missingCode });
    assert.equal((await extra.next('room-error')).reason, 'room-not-found');
    extra.socket.send('{');
    assert.equal((await extra.next('error')).message, 'Invalid JSON');

    cameraA.send({ type: 'offer', callId: 'a1', sdp: { type: 'offer', sdp: 'a' } });
    assert.equal((await monitorA.next('offer')).callId, 'a1');
    monitorA.send({ type: 'answer', callId: 'a1', sdp: { type: 'answer', sdp: 'b' } });
    assert.equal((await cameraA.next('answer')).callId, 'a1');
    cameraA.send({ type: 'candidate', callId: 'a1', candidate: { candidate: 'a' } });
    assert.equal((await monitorA.next('candidate')).callId, 'a1');
    monitorA.send({ type: 'stop', callId: 'a1' });
    assert.equal((await cameraA.next('stop')).callId, 'a1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(cameraB.messages, []);
    assert.deepEqual(monitorB.messages, []);

    monitorA.send({ type: 'leave-room' });
    await cameraA.next('peer-left');
    await cameraA.next('waiting');
    monitorA.send({ type: 'candidate', callId: 'a1', candidate: { candidate: 'stale' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(cameraA.messages, []);
    extra.send({ type: 'join-room', code: codeA });
    await extra.next('room-joined');
    await extra.next('ready');
    await cameraA.next('ready');
    monitorA.send({ type: 'candidate', callId: 'a1', candidate: { candidate: 'stale-after-rejoin' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(cameraA.messages, []);
    assert.deepEqual(extra.messages, []);
    cameraA.send({ type: 'offer', callId: 'a2', sdp: { type: 'offer', sdp: 'new' } });
    assert.equal((await extra.next('offer')).callId, 'a2');
    extra.send({ type: 'answer', callId: 'a2', sdp: { type: 'answer', sdp: 'new-answer' } });
    assert.equal((await cameraA.next('answer')).callId, 'a2');
    extra.socket.close();
    await cameraA.next('peer-left');
    await cameraA.next('waiting');
    monitorA.send({ type: 'join-room', code: codeA });
    await monitorA.next('room-joined');
    await monitorA.next('ready');
    await cameraA.next('ready');
    cameraA.send({ type: 'offer', callId: 'a3', sdp: { type: 'offer', sdp: 'same-monitor-rejoined' } });
    assert.equal((await monitorA.next('offer')).callId, 'a3');
    monitorA.send({ type: 'answer', callId: 'a3', sdp: { type: 'answer', sdp: 'rejoined-answer' } });
    assert.equal((await cameraA.next('answer')).callId, 'a3');

    monitorA.send({ type: 'leave-room' });
    await cameraA.next('peer-left');
    await cameraA.next('waiting');
    monitorA.send({ type: 'join-room', code: codeA });
    assert.equal((await monitorA.next('room-joined')).code, codeA);
    await monitorA.next('ready');
    await cameraA.next('ready');
    cameraA.send({ type: 'offer', callId: 'a4', sdp: { type: 'offer', sdp: 'third-call-same-room' } });
    assert.equal((await monitorA.next('offer')).callId, 'a4');
    monitorA.send({ type: 'answer', callId: 'a4', sdp: { type: 'answer', sdp: 'third-answer' } });
    assert.equal((await cameraA.next('answer')).callId, 'a4');

    cameraA.socket.close();
    assert.equal((await monitorA.next('room-ended')).code, codeA);
    monitorA.send({ type: 'join-room', code: codeA });
    assert.equal((await monitorA.next('room-error')).reason, 'room-not-found');
    cameraB.send({ type: 'leave-room' });
    assert.equal((await monitorB.next('room-ended')).code, codeB);
    monitorB.send({ type: 'create-room' });
    await monitorB.next('room-created');
  } finally {
    for (const client of sockets) client.socket.terminate();
    await app.close();
  }
});
