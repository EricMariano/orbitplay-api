import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsController } from './orgs.controller';
import { OrgsRepository } from './orgs.repository';
import { OrgsService } from './orgs.service';

@Module({
  // AuthModule exports PasswordService — used to hash the placeholder password
  // of an invited member. Service, never repository (module boundary rule).
  imports: [AuthModule],
  controllers: [OrgsController],
  providers: [OrgsService, OrgsRepository],
  exports: [OrgsService],
})
export class OrgsModule {}
