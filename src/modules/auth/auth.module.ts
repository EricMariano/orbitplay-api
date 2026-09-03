import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    // JwtService is used for access tokens by default; refresh tokens are signed
    // with the refresh secret passed explicitly at sign time (TokenService).
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get<string>('jwt.accessTtl') as unknown as number },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('authThrottle.ttl')! * 1000, // seconds → ms
            limit: config.get<number>('authThrottle.limit')!,
          },
          {
            // Opt-in only on GET /auth/signup/availability (see AuthController).
            name: 'availability',
            ttl: config.get<number>('authThrottle.availabilityTtl')! * 1000,
            limit: config.get<number>('authThrottle.availabilityLimit')!,
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordService, TokenService],
  exports: [JwtModule, PasswordService],
})
export class AuthModule {}
