import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { CommunityController } from './community.controller';
import { CommunityRepository } from './community.repository';
import { CommunityService } from './community.service';

@Module({
  imports: [GamesModule],
  controllers: [CommunityController],
  providers: [CommunityService, CommunityRepository],
})
export class CommunityModule {}
