import { z } from "zod";

import { UserSchema } from "../../contracts";

export const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  acceptedAgb: z.literal(true),
});

export const EmailLoginSchema = z.object({
  email: z.email(),
  category: z.enum(["guest", "login"]).optional(),
  acceptedAgb: z.literal(true),
  redirectTo: z.string().max(2048).optional(),
});

export const VerifyTokenSchema = z.object({
  token: z.uuid(),
  acceptedAgb: z.literal(true),
});

export const PasswordResetRequestSchema = z.object({
  email: z.email(),
  acceptedAgb: z.literal(true),
  redirectTo: z.string().max(2048).optional(),
});

export const PasswordResetCompleteSchema = z
  .object({
    token: z.uuid(),
    newPassword: z.string().min(8),
    confirmPassword: z.string().min(1),
    acceptedAgb: z.literal(true),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const AdminLoginSchema = z.object({
  token: z.string().min(1),
  restoreLocalLogin: z.boolean().default(false),
});

export const AuthResponseSchema = z.object({
  session_token: z.string(),
  user: UserSchema,
});

export const VerifyPasskeyAuthenticationSchema = z.object({
  response: z.unknown(),
  acceptedAgb: z.literal(true),
});
