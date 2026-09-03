import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
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
  ResetPasswordDto,
  SignupAvailabilityDto,
  SignupAvailabilityQueryDto,
  SignupPlayerDto,
  SignupStudioDto,
} from './dto/auth.dto';
import { AuthService } from './auth.service';

/**
 * Auth endpoints. Login and password recovery are rate-limited per IP by the
 * ThrottlerGuard and per identifier by AuthService (both dimensions, RN + §10.2).
 * Signup availability uses a dedicated, stricter `availability` throttler.
 * The access token is returned in the body; the refresh token is set as an
 * httpOnly cookie and rotated on every /refresh with reuse detection.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
// Skip both named throttlers by default; routes opt in with SkipThrottle({ name: false }).
@SkipThrottle({ default: true, availability: true })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: LoginResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, req, res);
  }

  @Public()
  @Post('signup/studio')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: LoginResponseDto })
  signupStudio(
    @Body() dto: SignupStudioDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.signupStudio(dto, req, res);
  }

  @Public()
  @Post('signup/player')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: LoginResponseDto })
  signupPlayer(
    @Body() dto: SignupPlayerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.signupPlayer(dto, req, res);
  }

  @Public()
  @Get('signup/availability')
  @SkipThrottle({ availability: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SignupAvailabilityDto })
  checkAvailability(@Query() query: SignupAvailabilityQueryDto) {
    return this.auth.checkSignupAvailability(query.email);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: LoginResponseDto })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: MessageResponseDto })
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @ApiBearerAuth()
  @Get('me')
  @ZodResponse({ type: AuthUserDto })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @Public()
  @Post('password/forgot')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: MessageResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('password/reset')
  @SkipThrottle({ default: false })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: MessageResponseDto })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto, req);
  }
}
