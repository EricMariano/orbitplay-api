import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Login accepts ONLY credentials. There is deliberately no role/tab field —
 * the role comes from the user's membership (server-side), never the request
 * body (RN-03, Tela 01).
 */
export const loginSchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token obrigatório'),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
});

/** Studio signup — creates user + organization + owner membership (ORB-M1-02). */
export const signupStudioSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
  birthdate: z.iso.date(),
  organizationName: z.string().min(1).max(200),
  acceptedTerms: z.boolean().optional(),
});

/** Player signup — creates user + personal org + player membership (ORB-M1-03). */
export const signupPlayerSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
  birthdate: z.iso.date(),
  acceptedTerms: z.boolean().optional(),
});

/** Query for GET /auth/signup/availability (ORB-M1-04). */
export const signupAvailabilityQuerySchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
});

/** Intentionally sparse — boolean only (anti-enumeration). */
export const signupAvailabilitySchema = z.object({
  available: z.boolean(),
});

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  organizationId: z.string(),
  role: z.enum(['owner', 'admin', 'studio', 'player']),
});

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  user: authUserSchema,
});

export const messageResponseSchema = z.object({ message: z.string() });

export class LoginDto extends createZodDto(loginSchema) {}
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
export class SignupStudioDto extends createZodDto(signupStudioSchema) {}
export class SignupPlayerDto extends createZodDto(signupPlayerSchema) {}
export class SignupAvailabilityQueryDto extends createZodDto(signupAvailabilityQuerySchema) {}
export class SignupAvailabilityDto extends createZodDto(signupAvailabilitySchema) {}
export class AuthUserDto extends createZodDto(authUserSchema) {}
export class LoginResponseDto extends createZodDto(loginResponseSchema) {}
export class MessageResponseDto extends createZodDto(messageResponseSchema) {}

export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthUserView = z.infer<typeof authUserSchema>;
export type SignupStudioInput = z.infer<typeof signupStudioSchema>;
export type SignupPlayerInput = z.infer<typeof signupPlayerSchema>;
export type SignupAvailability = z.infer<typeof signupAvailabilitySchema>;
