import { redis } from "bun";

/** Requested by email or username on the login page; resolves the account through its email at use. */
export type EmailLoginTokenPayload = { email: string; category?: "guest" | "login" };
/** Issued by an administrator for one account; works without an email address. */
export type AccountLoginTokenPayload = { userId: string };

const loginTokenKey = (token: string) => `email-login:${token}`;

export const createMagicLinkToken = async (params: {
  email: string;
  category?: "guest" | "login";
  ttlSeconds?: number;
}): Promise<string> => {
  const token = crypto.randomUUID();
  await redis.set(loginTokenKey(token), JSON.stringify({ email: params.email, category: params.category }), "EX", params.ttlSeconds ?? 300);
  return token;
};

/** Shares the email-link key space, so both token kinds use the same link and verify endpoint. */
export const createAccountLoginToken = async (params: { userId: string; ttlSeconds?: number }): Promise<string> => {
  const token = crypto.randomUUID();
  await redis.set(loginTokenKey(token), JSON.stringify({ userId: params.userId }), "EX", params.ttlSeconds ?? 300);
  return token;
};

export const consumeMagicLinkToken = async (token: string): Promise<EmailLoginTokenPayload | AccountLoginTokenPayload | null> => {
  const raw = await redis.getdel(loginTokenKey(token));
  if (!raw) return null;
  return JSON.parse(raw) as EmailLoginTokenPayload | AccountLoginTokenPayload;
};

type PasswordResetPayload = {
  userId: string;
  uid: string;
  email: string;
};

const passwordResetTokenKey = (token: string) => `password-reset:${token}`;

export const createPasswordResetToken = async (params: PasswordResetPayload & { ttlSeconds?: number }): Promise<string> => {
  const token = crypto.randomUUID();
  await redis.set(
    passwordResetTokenKey(token),
    JSON.stringify({
      userId: params.userId,
      uid: params.uid,
      email: params.email,
    }),
    "EX",
    params.ttlSeconds ?? 900,
  );
  return token;
};

export const consumePasswordResetToken = async (token: string): Promise<PasswordResetPayload | null> => {
  const raw = await redis.getdel(passwordResetTokenKey(token));
  if (!raw) return null;
  return JSON.parse(raw) as PasswordResetPayload;
};
