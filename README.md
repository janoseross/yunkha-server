# Yunkha signaling backend

Standalone NestJS + TypeScript replacement for Yunkha's Node.js signaling server. It uses `@nestjs/platform-ws` and native `ws` WebSockets. Existing mobile and web clients send the same messages without source changes. This is the Day 6 local implementation; no cloud resources are created.

WebRTC media stays peer-to-peer between Camera and Monitor. This backend relays connection metadata (SDP and ICE), room events and stop messages; it does not receive or store video.

## Installation and startup

Requires Node.js 22+ and npm.

```sh
npm install
npm run build
npm run lint
npm test
```

Start alongside the existing server on port 8787 using a different port:

```sh
PORT=8788 npm start
```

Connect to `ws://127.0.0.1:8788/`. Do not start a second server on 8787 while the original is running. `npm start` builds before starting; after building, `npm run start:prod` runs the compiled application directly. Ctrl+C shuts it down and releases connected sockets.

Environment configuration is optional. Copy `.env.example` to `.env` if desired; the startup commands load it using Node's built-in env-file support. Shell environment variables take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listening port; `0` selects an ephemeral port. Must be 0–65535. |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for loopback-only development. |

Tests never use the default port. They create real NestJS applications listening on `127.0.0.1:0` and use real WebSocket clients.

## Architecture

```text
src/
  main.ts                         Nest bootstrap, WsAdapter, environment, shutdown
  app.module.ts                   Dependency registration
  signaling/
    signaling.gateway.ts          Raw WebSocket frames, connection/error/close lifecycle
    signaling.service.ts          Parsing, protocol checks, ordered replies, relaying
    room-registry.ts              In-memory rooms and socket membership transitions
    signaling.types.ts            Protocol, roles and membership types
test/
  helpers.cjs                     Ephemeral Nest endpoint and ordered WS assertions
  original-scenario.test.cjs       Existing server integration scenario, ported
  protocol.test.cjs                Protocol edge cases and lifecycle integration tests
  mobile-client.test.cjs           Optional unchanged mobile wrapper compatibility check
```

The gateway attaches a raw `message` listener because Nest's standard message dispatch expects `{ event, data }`, while Yunkha uses `{ type, ... }`. No Socket.IO framing, Nest response wrapper, guards or validation pipes are introduced. Replies are sent explicitly, preserving parse errors, silent ignores, and message ordering. See the [Nest native WebSocket adapter documentation](https://docs.nestjs.com/websockets/adapter).

The registry owns membership and returns ordered peer notifications on leave. Clearing membership before notifying makes later disconnects idempotent. The service also evicts closing/closed members during joins, matching the original server. Nest's adapter owns endpoint shutdown and terminates connected sockets.

## Protocol and compatibility contract

The source of truth is the existing mobile repository's `scripts/signaling-server.cjs`, `scripts/signaling-server.test.cjs`, `src/services/signaling/signalingClient.ts`, and `src/services/signaling/types.ts`. The web implementation in `src/Camera.tsx`, `src/App.tsx`, and `src/signaling.ts` uses the same protocol.

### Connection and roles

The original endpoint listens on `0.0.0.0:8787`; clients receive a configurable native WebSocket URL. No authentication, subprotocol, greeting, role handshake, automatic room assignment or automatic reconnect exists. Use the root URL (`ws://host:port/` locally, `wss://host/` behind TLS).

Each connection starts outside a room. Creating a room makes it the Camera (`sender` internally). Joining makes it the Monitor (`receiver`). Each socket can belong to one room, with exactly one Camera and at most one Monitor. Role names are internal and are not sent in a role message.

Room codes contain four uppercase letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (24 letters, excluding I and O). Creation uses cryptographic random selection with collision avoidance. Join codes are trimmed and uppercased, then validated; invalid characters are rejected, not filtered out. Rooms are independent.

### Requests and ordered replies

| Client request | Server behavior |
| --- | --- |
| `{"type":"create-room"}` | Camera receives `{"type":"room-created","code":"ABCD"}`, then `{"type":"waiting"}`. |
| `{"type":"join-room","code":"ABCD"}` | Monitor receives `room-joined` with normalized `code`, then `ready`. Server then sends `ready` to Camera. |
| `{"type":"leave-room"}` from Monitor | Monitor membership clears; Camera receives `peer-left`, then `waiting`. Room and Camera remain. No acknowledgement to Monitor. |
| `{"type":"leave-room"}` from Camera | Room is deleted; Monitor membership clears and Monitor receives `room-ended` with `code`. No acknowledgement to Camera. |
| `{"type":"offer","callId":"c1","sdp":{"type":"offer","sdp":"..."}}` | Camera → current Monitor only. |
| `{"type":"answer","callId":"c1","sdp":{"type":"answer","sdp":"..."}}` | Monitor → current Camera only. |
| `{"type":"candidate","callId":"c1","candidate":{"candidate":"...","sdpMid":null,"sdpMLineIndex":0}}` | Either member → the other member. ICE optional fields may be omitted. |
| `{"type":"stop","callId":"c1"}` | Either member → the other member. Membership and room remain intact. |

Ordering refers to server send order; delivery across separate sockets is not globally synchronized.

Relayed JSON objects retain all supplied properties. Like the original server, the backend checks a string `callId` and the sending role/membership, but does not validate SDP, ICE or call sequencing. Even an empty string `callId` is accepted. Clients handle stale call IDs. No message is buffered when the peer is absent or not open. Wrong-role offers/answers, missing/nonstring call IDs, signaling from nonmembers and unknown string message types are silently ignored.

### Errors

Errors are sent without closing the socket.

| Situation | Exact reply |
| --- | --- |
| JSON parsing fails | `{"type":"error","message":"Invalid JSON"}` |
| Parsed value is null, an array, nonobject, or lacks a string `type` | `{"type":"error","message":"Invalid message"}` |
| Create or join while already in a room | `{"type":"room-error","reason":"already-in-room"}` |
| All 24⁴ codes occupied | `{"type":"room-error","reason":"rooms-full"}` |
| Invalid/missing join code | `{"type":"room-error","reason":"invalid-room-code"}` |
| Valid code without a live Camera room | `{"type":"room-error","reason":"room-not-found"}` |
| Room already has a live Monitor | `{"type":"room-error","reason":"room-full"}` |
| Leave while outside a room | `{"type":"room-error","reason":"not-in-room"}` |

For create/join, `already-in-room` takes precedence over other validation. Join first checks code syntax, then Camera availability, then Monitor occupancy. Text and binary frames containing JSON are accepted, matching the old parser.

### Disconnect, cleanup and reconnection

A WebSocket close applies the same room transition as `leave-room`, then removes the connection record. Transport errors clear membership and terminate the connection safely. Subsequent close events do not duplicate peer notifications.

Monitor leave/disconnect frees the slot for the same Monitor or a new connection. Camera stop/restart reuses the existing room and connection with a new client-generated call ID. Camera leave/disconnect deletes the room and detaches the Monitor, which can then create or join another room on its existing socket. Deleted room codes become available for future random allocation. Reconnecting creates a fresh connection; rooms are not restored automatically. The server adds no heartbeat, resumption or reconnection protocol.

## Tests and local verification

```sh
npm run build
npm run lint
npm test
```

`npm test` compiles and runs Node's built-in test runner, without Jest or mocked sockets. The original integration scenario was copied with only server startup/shutdown and port selection adapted to NestJS. Additional tests check strict message order, invalid codes, membership error precedence, malformed JSON and envelopes, unknown types, binary JSON, room isolation, SDP/ICE forwarding in both directions, opaque payload preservation, silent ignores, repeated Monitor leave/rejoin, Camera stop/restart, abrupt disconnections, stale membership, cleanup, role reuse and shutdown.

The optional mobile compatibility test reads the actual sibling `SignalingClient` source, transpiles it in memory, and exercises it against Nest using Node 22's browser-compatible WebSocket API. It does not edit the mobile repo. It is skipped if the sibling repository is absent; override its location with `YUNKHA_MOBILE_ROOT=/path/to/yunkha`. This checks the signaling wrapper, not a device's media capture or full WebRTC session.

For a manual device/browser check, temporarily supply `EXPO_PUBLIC_SIGNALING_URL` (mobile) or `VITE_SIGNALING_URL` (web) as `ws://<development-machine-LAN-IP>:8788`. Use each app's existing configuration mechanism; no permanent client configuration changes are needed. Camera access may require HTTPS in a remote browser. Full media validation requires two clients and is separate from signaling tests.

The `rooms-full` branch is preserved but not exercised by opening 331,776 rooms. The tests verify room/connection reuse without relying on random generation to return a particular deleted code.

## Limitations and Day 7

- All rooms and membership live in one process's memory. Restarts remove them; multiple independent instances cannot share rooms.
- No authentication or authorization beyond room membership. Room codes are pairing conveniences, not security credentials.
- No persistence, message queue, retry buffering, heartbeat, rate limiting or application-specific payload validation. Native `ws` transport defaults apply, with compression disabled as in the original.
- No TURN service or media proxy is included. Actual peer connectivity depends on clients' ICE configuration and network conditions.
- HTTP serves no application routes or health endpoint. TLS is expected at a future deployment boundary.

Day 7 work: finish any pending local verification, choose/configure Google Cloud hosting for long-lived WebSockets, build the deployment artifact, terminate TLS for `wss://`, set port/environment configuration, plan connection timeouts/reconnects and process restarts, and add appropriate operational health checks/logging. Keep a single instance or explicitly design shared routing/state before scaling. Then temporarily point existing clients at the new endpoint and verify end-to-end video across networks. No deployment was performed on Day 6.

See [VERIFICATION.md](VERIFICATION.md) for the execution status in the implementation environment.
