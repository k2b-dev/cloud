import type { Socket } from "node:net";
import { createTransport } from "nodemailer";
import type { resolveMailCredentials } from "./store";

export const buildMailTransport = (profile: Awaited<ReturnType<typeof resolveMailCredentials>>, socket?: Socket) =>
  createTransport({
    // Workers own the raw socket so timeout/shutdown can destroy it. Nodemailer
    // still owns SMTP and upgrades this socket for implicit TLS or STARTTLS.
    ...(socket ? { socket } : {}),
    host: profile.smtpHost,
    port: profile.smtpPort,
    secure: profile.smtpSecure,
    ...(profile.smtpUser ? { auth: { user: profile.smtpUser, pass: profile.smtpPassword ?? "" } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
