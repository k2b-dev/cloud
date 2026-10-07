import { createTransport } from "nodemailer";
import type { resolveMailCredentials } from "./store";

export const buildMailTransport = (profile: Awaited<ReturnType<typeof resolveMailCredentials>>) =>
  createTransport({
    host: profile.smtpHost,
    port: profile.smtpPort,
    secure: profile.smtpSecure,
    ...(profile.smtpUser ? { auth: { user: profile.smtpUser, pass: profile.smtpPassword ?? "" } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
