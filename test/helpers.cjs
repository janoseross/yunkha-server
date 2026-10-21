const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createApplication } = require('../dist/main');

async function setup(t) {
  const app = await createApplication(false);
  const sockets = [];
  let closed = false;
  async function shutdown() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.terminate();
    await app.close();
  }
  t.after(shutdown);
  await app.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${app.getHttpServer().address().port}`;

  async function connect() {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const messages = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    // Keep errors handled during abrupt disconnect tests too.
    socket.on('error', () => {});
    return {
      socket, messages,
      send(message) { socket.send(JSON.stringify(message)); },
      async next() {
        for (let i = 0; i < 300; i += 1) {
          if (messages.length) return messages.shift();
          await delay(10);
        }
        throw new Error('Timed out waiting for a WebSocket message');
      },
      async expect(message) { assert.deepEqual(await this.next(), message); },
      async quiet() {
        await delay(80);
        assert.deepEqual(messages, []);
      },
    };
  }

  async function create(camera) {
    camera.send({ type: 'create-room' });
    const created = await camera.next();
    assert.equal(created.type, 'room-created');
    assert.match(created.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    await camera.expect({ type: 'waiting' });
    return created.code;
  }

  async function join(monitor, camera, code, input = code) {
    monitor.send({ type: 'join-room', code: input });
    await monitor.expect({ type: 'room-joined', code });
    await monitor.expect({ type: 'ready' });
    await camera.expect({ type: 'ready' });
  }

  return { app, url, connect, create, join, shutdown };
}

module.exports = { setup };
