import { Injectable } from '@nestjs/common';
import { WebSocket, type RawData } from 'ws';
import { RoomRegistry } from './room-registry';
import { ROOM_ALPHABET, type Delivery, type OutboundMessage, type WireMessage } from './signaling.types';

@Injectable()
export class SignalingService {
  constructor(private readonly registry: RoomRegistry) {}

  connect(socket: WebSocket): void {
    this.registry.connect(socket);
  }

  disconnect(socket: WebSocket): void {
    this.deliver(this.registry.disconnect(socket));
  }

  private send(socket: WebSocket | null, message: OutboundMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private deliver(deliveries: Delivery[]): void {
    for (const { socket, message } of deliveries) this.send(socket, message);
  }

  private leave(socket: WebSocket): void {
    this.deliver(this.registry.leave(socket));
  }

  handleMessage(socket: WebSocket, data: RawData): void {
    let parsed: unknown;
    try {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data as ArrayBuffer).toString();
      parsed = JSON.parse(text);
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('type' in parsed) || typeof parsed.type !== 'string') {
      this.send(socket, { type: 'error', message: 'Invalid message' });
      return;
    }
    const message = parsed as WireMessage;
    const client = this.registry.client(socket);
    if (!client) return;

    if (message.type === 'create-room') {
      if (client.roomCode) {
        this.send(socket, { type: 'room-error', reason: 'already-in-room' });
        return;
      }
      const code = this.registry.create(socket);
      if (!code) {
        this.send(socket, { type: 'room-error', reason: 'rooms-full' });
        return;
      }
      this.send(socket, { type: 'room-created', code });
      this.send(socket, { type: 'waiting' });
      return;
    }

    if (message.type === 'join-room') {
      if (client.roomCode) {
        this.send(socket, { type: 'room-error', reason: 'already-in-room' });
        return;
      }
      const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
      if (code.length !== 4 || ![...code].every((character) => ROOM_ALPHABET.includes(character))) {
        this.send(socket, { type: 'room-error', reason: 'invalid-room-code' });
        return;
      }
      const room = this.registry.room(code);
      if (room && room.camera.readyState !== WebSocket.OPEN) this.leave(room.camera);
      if (!this.registry.room(code) || !room) {
        this.send(socket, { type: 'room-error', reason: 'room-not-found' });
        return;
      }
      if (room.monitor && room.monitor.readyState !== WebSocket.OPEN) this.leave(room.monitor);
      if (room.monitor) {
        this.send(socket, { type: 'room-error', reason: 'room-full' });
        return;
      }
      this.registry.join(socket, room);
      this.send(socket, { type: 'room-joined', code });
      this.send(socket, { type: 'ready' });
      this.send(room.camera, { type: 'ready' });
      return;
    }

    if (message.type === 'leave-room') {
      if (!client.roomCode) {
        this.send(socket, { type: 'room-error', reason: 'not-in-room' });
        return;
      }
      this.leave(socket);
      return;
    }

    if (!['offer', 'answer', 'candidate', 'stop'].includes(message.type)) return;
    if (message.type === 'offer' && client.role !== 'sender') return;
    if (message.type === 'answer' && client.role !== 'receiver') return;
    if (typeof message.callId !== 'string') return;
    const room = this.registry.room(client.roomCode);
    if (!room || room[client.role === 'sender' ? 'camera' : 'monitor'] !== socket) return;
    this.send(client.role === 'sender' ? room.monitor : room.camera, message);
  }
}
