import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GamesModule } from '../games/games.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatRealtimeService } from './chat.realtime';
import { ChatRepository } from './chat.repository';
import { ChatService } from './chat.service';

/** AuthModule is imported for its JwtService — the gateway verifies the access token at handshake. */
@Module({
  imports: [GamesModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository, ChatRealtimeService, ChatGateway],
})
export class ChatModule {}
