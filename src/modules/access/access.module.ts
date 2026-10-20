import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { OrgsModule } from '../orgs/orgs.module';
import { GameAccessController, OrgGroupsController } from './access.controller';
import { AccessRepository } from './access.repository';
import { AccessService } from './access.service';

@Module({
  imports: [OrgsModule, GamesModule],
  controllers: [OrgGroupsController, GameAccessController],
  providers: [AccessService, AccessRepository],
  exports: [AccessService],
})
export class AccessModule {}
