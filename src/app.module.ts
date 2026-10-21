import { Module } from '@nestjs/common';
import { RoomRegistry } from './signaling/room-registry';
import { SignalingGateway } from './signaling/signaling.gateway';
import { SignalingService } from './signaling/signaling.service';

@Module({ providers: [RoomRegistry, SignalingService, SignalingGateway] })
export class AppModule {}
