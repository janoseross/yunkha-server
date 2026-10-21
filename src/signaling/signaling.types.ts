import type { WebSocket } from 'ws';

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export type Role = 'sender' | 'receiver'; // Camera and Monitor respectively.
export type RoomErrorReason =
  | 'already-in-room' | 'rooms-full' | 'invalid-room-code'
  | 'room-not-found' | 'room-full' | 'not-in-room';

export type RelayMessage =
  | { type: 'offer' | 'answer'; callId: string; sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { type: 'candidate'; callId: string; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }
  | { type: 'stop'; callId: string };

export type ClientMessage =
  | { type: 'create-room' | 'leave-room' }
  | { type: 'join-room'; code: string }
  | RelayMessage;

export type ServerMessage =
  | { type: 'room-created' | 'room-joined' | 'room-ended'; code: string }
  | { type: 'waiting' | 'ready' | 'peer-left' }
  | { type: 'room-error'; reason: RoomErrorReason }
  | { type: 'error'; message: 'Invalid JSON' | 'Invalid message' }
  | RelayMessage;

// Incoming SDP/ICE and extra properties are deliberately opaque: the original
// server validates only the envelope, role and string callId before forwarding.
export type WireMessage = Record<string, unknown> & { type: string };
export type OutboundMessage = ServerMessage | WireMessage;
export interface ClientMembership { role: Role | null; roomCode: string | null }
export interface Room { code: string; camera: WebSocket; monitor: WebSocket | null }
export interface Delivery { socket: WebSocket; message: ServerMessage }
