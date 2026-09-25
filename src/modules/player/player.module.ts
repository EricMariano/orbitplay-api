import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { FeedController } from './feed.controller';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';

@Module({
  imports: [GamesModule],
  controllers: [FeedController],
  providers: [FeedRepository, FeedService],
})
export class PlayerModule {}
