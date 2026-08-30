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
export class AuthUserDto extends createZodDto(authUserSchema) {}
export class LoginResponseDto extends createZodDto(loginResponseSchema) {}
export class MessageResponseDto extends createZodDto(messageResponseSchema) {}

export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthUserView = z.infer<typeof authUserSchema>;
