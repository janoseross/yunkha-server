import { Logger } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayDisconnect } from '@nestjs/websockets';
import { WebSocket, type RawData } from 'ws';
import { SignalingService } from './signaling.service';

@WebSocketGateway({ perMessageDeflate: false })
export class SignalingGateway implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket> {
  private readonly logger = new Logger(SignalingGateway.name);

  constructor(private readonly signaling: SignalingService) {}

  handleConnection(socket: WebSocket): void {
    this.signaling.connect(socket);
    // Own raw frames to preserve Yunkha's type-based JSON and parsing errors.
    // Nest's default message mapping expects { event, data } instead.
    socket.on('message', (data: RawData) => this.signaling.handleMessage(socket, data));
    socket.on('error', (error: Error) => {
      this.logger.warn(`WebSocket error: ${error.message}`);
      this.signaling.disconnect(socket);
      socket.terminate();
    });
  }

  handleDisconnect(socket: WebSocket): void {
    this.signaling.disconnect(socket);
  }

}
