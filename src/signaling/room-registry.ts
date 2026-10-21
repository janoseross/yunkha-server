import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { ROOM_ALPHABET, type ClientMembership, type Delivery, type Room } from './signaling.types';

@Injectable()
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<WebSocket, ClientMembership>();

  connect(socket: WebSocket): void {
    this.clients.set(socket, { role: null, roomCode: null });
  }

  client(socket: WebSocket): ClientMembership | undefined {
    return this.clients.get(socket);
  }

  room(code: string | null): Room | undefined {
    return code === null ? undefined : this.rooms.get(code);
  }

  create(socket: WebSocket): string | null {
    if (this.rooms.size === ROOM_ALPHABET.length ** 4) return null;
    let code: string;
    do {
      code = Array.from({ length: 4 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    this.rooms.set(code, { code, camera: socket, monitor: null });
    this.clients.set(socket, { role: 'sender', roomCode: code });
    return code;
  }

  join(socket: WebSocket, room: Room): void {
    room.monitor = socket;
    this.clients.set(socket, { role: 'receiver', roomCode: room.code });
  }

  leave(socket: WebSocket): Delivery[] {
    const client = this.clients.get(socket);
    if (!client?.roomCode) return [];
    const room = this.rooms.get(client.roomCode);
    client.roomCode = null;
    client.role = null;
    if (!room) return [];
    if (room.camera === socket) {
      this.rooms.delete(room.code);
      if (!room.monitor) return [];
      const monitor = this.clients.get(room.monitor);
      if (monitor) {
        monitor.roomCode = null;
        monitor.role = null;
      }
      return [{ socket: room.monitor, message: { type: 'room-ended', code: room.code } }];
    }
    if (room.monitor === socket) {
      room.monitor = null;
      return [
        { socket: room.camera, message: { type: 'peer-left' } },
        { socket: room.camera, message: { type: 'waiting' } },
      ];
    }
    return [];
  }

  disconnect(socket: WebSocket): Delivery[] {
    const deliveries = this.leave(socket);
    this.clients.delete(socket);
    return deliveries;
  }
}
