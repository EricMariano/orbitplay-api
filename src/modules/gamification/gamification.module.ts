import { Module } from '@nestjs/common';
import { GamificationController } from './gamification.controller';
import { GamificationRepository } from './gamification.repository';
import { GamificationService } from './gamification.service';

@Module({
  controllers: [GamificationController],
  providers: [GamificationService, GamificationRepository],
})
export class GamificationModule {}
