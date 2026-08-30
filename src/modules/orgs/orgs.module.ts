import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller';
import { OrgsRepository } from './orgs.repository';
import { OrgsService } from './orgs.service';

@Module({
  controllers: [OrgsController],
  providers: [OrgsService, OrgsRepository],
  exports: [OrgsService],
})
export class OrgsModule {}
