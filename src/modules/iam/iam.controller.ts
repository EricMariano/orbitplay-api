import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { ZodResponse } from 'nestjs-zod';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import type { AuthUser } from '../../shared/auth/roles';
import {
  AuthUserDto,
  ForgotPasswordDto,
  LoginDto,
  LoginResponseDto,
  MessageResponseDto,
} from './dto/auth.dto';
import { IamService } from './iam.service';

/**
 * Auth endpoints. Login and password recovery are rate-limited per IP by the
 * ThrottlerGuard and per identifier by IamService (both dimensions, RN + §10.2).
 * The access token is returned in the body; the refresh token is set as an
 * httpOnly cookie and rotated on every /refresh with reuse detection.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
@SkipThrottle() // throttling is opted-in per route below
export class IamController {
  constructor(private readonly iam: IamService) {}

  @Public()
  @Post('login')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: LoginResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.iam.login(dto, req, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: LoginResponseDto })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.iam.refresh(req, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: MessageResponseDto })
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.iam.logout(req, res);
  }

  @ApiBearerAuth()
  @Get('me')
  @ZodResponse({ type: AuthUserDto })
  me(@CurrentUser() user: AuthUser) {
    return this.iam.me(user);
  }

  @Public()
  @Post('password/forgot')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: MessageResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.iam.forgotPassword(dto);
  }
}
