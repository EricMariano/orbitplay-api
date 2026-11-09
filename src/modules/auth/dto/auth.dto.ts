import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Upper bound so a huge password can't be used to burn CPU in argon2. */
const PASSWORD_MAX = 256;

/**
 * Login accepts credentials plus, optionally, which org to open a session
 * for. There is still deliberately no role/tab field — the role always comes
 * from the matched membership (server-side), never the request body (RN-03,
 * Tela 01); `organizationId` only selects *which* of the caller's own active
 * memberships to use when they have more than one (GAP-02) — it can never
 * grant a role or org the account doesn't already hold.
 */
export const loginSchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória').max(PASSWORD_MAX, 'Senha muito longa'),
  organizationId: z.string().min(1).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token obrigatório'),
  password: z
    .string()
    .min(8, 'Senha deve ter no mínimo 8 caracteres')
    .max(PASSWORD_MAX, 'Senha muito longa'),
});

/** Studio signup — creates user + organization + owner membership (ORB-M1-02). */
export const signupStudioSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z
    .string()
    .min(8, 'Senha deve ter no mínimo 8 caracteres')
    .max(PASSWORD_MAX, 'Senha muito longa'),
  birthdate: z.iso.date(),
  organizationName: z.string().min(1).max(200),
  acceptedTerms: z.boolean().optional(),
});

/** Player signup — creates user + personal org + player membership (ORB-M1-03). */
export const signupPlayerSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  password: z
    .string()
    .min(8, 'Senha deve ter no mínimo 8 caracteres')
    .max(PASSWORD_MAX, 'Senha muito longa'),
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

/**
 * A user with more than one active membership (a studio staffer invited into
 * a second org, e.g.) can't have `login` silently guess which one they mean
 * (GAP-02) — this is what it returns instead, listing the orgs to choose
 * from. The caller resubmits `POST /auth/login` with `organizationId` set to
 * one of these ids.
 */
export const loginOrganizationOptionSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.enum(['owner', 'admin', 'studio', 'player']),
});

export const organizationSelectionRequiredSchema = z.object({
  requiresOrganizationSelection: z.literal(true),
  organizations: z.array(loginOrganizationOptionSchema),
});

export const loginResultSchema = z.union([
  loginResponseSchema,
  organizationSelectionRequiredSchema,
]);

export const messageResponseSchema = z.object({ message: z.string() });

/** Body of POST /auth/invite/preview — the token travels in the body, never in a URL that gets logged. */
export const invitePreviewRequestSchema = z.object({
  token: z.string().min(1, 'Token obrigatório').max(PASSWORD_MAX, 'Token inválido'),
});

/**
 * What the invitee sees before accepting. `accountExists`: the e-mail already
 * has an account of its own (it signed up, or already belongs to an org) — it
 * accepts with its CURRENT password and the invite never changes it. Otherwise
 * the account was created by the invite and the invitee picks the password
 * here. `birthdateRequired`: the account has no birthdate yet (18+ rule).
 */
export const invitePreviewSchema = z.object({
  organizationName: z.string(),
  role: z.enum(['owner', 'admin', 'studio', 'player']),
  email: z.string(),
  accountExists: z.boolean(),
  birthdateRequired: z.boolean(),
});

/**
 * Body of POST /auth/invite/accept. Which fields apply comes from the preview:
 * a new account sends `password` (+ `birthdate`); an existing one sends
 * `currentPassword` (+ `birthdate` if it has none). The service enforces it.
 */
export const acceptInviteSchema = z.object({
  token: z.string().min(1, 'Token obrigatório').max(PASSWORD_MAX, 'Token inválido'),
  password: z
    .string()
    .min(8, 'Senha deve ter no mínimo 8 caracteres')
    .max(PASSWORD_MAX, 'Senha muito longa')
    .optional(),
  currentPassword: z
    .string()
    .min(1, 'Senha obrigatória')
    .max(PASSWORD_MAX, 'Senha muito longa')
    .optional(),
  birthdate: z.iso.date().optional(),
});

export const acceptInviteResponseSchema = z.object({
  message: z.string(),
  email: z.string(),
  organizationName: z.string(),
});

export class LoginDto extends createZodDto(loginSchema) {}
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
export class SignupStudioDto extends createZodDto(signupStudioSchema) {}
export class SignupPlayerDto extends createZodDto(signupPlayerSchema) {}
export class SignupAvailabilityQueryDto extends createZodDto(signupAvailabilityQuerySchema) {}
export class SignupAvailabilityDto extends createZodDto(signupAvailabilitySchema) {}
export class AuthUserDto extends createZodDto(authUserSchema) {}
export class LoginResponseDto extends createZodDto(loginResponseSchema) {}
// A union schema's inferred constructor return type isn't a single object
// type, so TS refuses `class X extends createZodDto(unionSchema) {}` here
// (unlike every other DTO in this file) — `createZodDto`'s return value is
// already a valid `ZodDto`, so it's used directly instead of subclassed.
export const LoginResultDto = createZodDto(loginResultSchema);
// Without a named subclass, Nest/Swagger falls back to an anonymous
// "AugmentedZodDto_Output" model name in the generated OpenAPI doc.
Object.defineProperty(LoginResultDto, 'name', { value: 'LoginResultDto', configurable: true });
export class MessageResponseDto extends createZodDto(messageResponseSchema) {}
export class InvitePreviewRequestDto extends createZodDto(invitePreviewRequestSchema) {}
export class InvitePreviewDto extends createZodDto(invitePreviewSchema) {}
export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
export class AcceptInviteResponseDto extends createZodDto(acceptInviteResponseSchema) {}

export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type OrganizationSelectionRequired = z.infer<typeof organizationSelectionRequiredSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type AuthUserView = z.infer<typeof authUserSchema>;
export type SignupStudioInput = z.infer<typeof signupStudioSchema>;
export type SignupPlayerInput = z.infer<typeof signupPlayerSchema>;
export type SignupAvailability = z.infer<typeof signupAvailabilitySchema>;
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type AcceptInviteResult = z.infer<typeof acceptInviteResponseSchema>;
