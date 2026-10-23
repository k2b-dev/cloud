import { Socket } from "node:net";
import { audit } from "../audit";
import { DownstreamBusyError, downstreamBudget } from "../downstream-budget";
import { get } from "../settings";
import { type MailAuditContext, OutgoingMailError, resolveMailCredentials } from "./store";
import { resolveMailTransport } from "./transport";

export const smtpFailureMessage = (error: unknown, secrets: readonly (string | null)[]): string => {
  let message = error instanceof Error ? error.message : "SMTP delivery failed.";
  for (const secret of secrets.filter((s): s is string => !!s)) {
    for (const representation of [secret, Buffer.from(secret).toString("base64")])
      message = message.split(representation).join("[REDACTED]");
  }
  return message;
};
export const outgoingMailTest = {
  async send(key: string, recipient: string, context: MailAuditContext): Promise<void> {
    const profile = await resolveMailCredentials(key);
    const event = { ...context, action: "outgoing_mail.profile.test", target: { type: "outgoing_mail_profile", id: key } };
    // Fail before the external effect if audit storage is unavailable.
    await audit.record({ ...event, outcome: "allowed" });
    let transport: ReturnType<Awaited<ReturnType<typeof resolveMailTransport>>["build"]> | undefined;
    const signal = AbortSignal.timeout(60_000);
    let socket: Socket | undefined;
    const stop = () => {
      socket?.destroy();
      transport?.close();
    };
    signal.addEventListener("abort", stop, { once: true });
    let releaseSmtp: (() => void) | undefined;
    try {
      releaseSmtp = await downstreamBudget.acquire({ downstream: "smtp", timeoutMs: 60_000, signal });
      const resolved = await resolveMailTransport(profile, signal);
      const build = (index: number) => {
        socket = new Socket();
        const ownedSocket = socket;
        ownedSocket.once("connect", () => {
          if (signal.aborted) ownedSocket.destroy();
        });
        return resolved.build(index, ownedSocket);
      };
      let selected = 0;
      for (let index = 0; index < resolved.count; index++) {
        signal.throwIfAborted();
        transport = build(index);
        try {
          // CONN also labels socket errors after DATA. Only fall back during a
          // preflight that cannot send a message, then send once to that address.
          await transport.verify();
          selected = index;
          break;
        } catch (error) {
          socket?.destroy();
          transport.close();
          transport = undefined;
          if (!(error instanceof Error) || !("command" in error) || error.command !== "CONN" || index === resolved.count - 1) throw error;
        }
      }
      if (!transport) throw new Error("No validated SMTP address.");
      // verify() closes its SMTP connection. The actual send gets a fresh
      // owned socket to the same checked address, with no delivery fallback.
      stop();
      signal.throwIfAborted();
      transport = build(selected);
      await transport.sendMail({
        from: { address: profile.fromAddress, name: profile.fromName ?? (await get<string>("app.name")) },
        to: recipient,
        subject: "Cloud test email",
        text: "This is a test email from Cloud. SMTP delivery is configured correctly if you received it.",
      });
    } catch (error) {
      const message = smtpFailureMessage(error, [
        profile.smtpPassword,
        profile.smtpUser,
        profile.smtpUser ? `\0${profile.smtpUser}\0${profile.smtpPassword ?? ""}` : null,
      ]);
      await audit.recordResultAfterSideEffect({ ...event, result: { ok: false, error: { code: "smtp_failed", message, status: 500 } } });
      throw new OutgoingMailError("smtp_failed", message, error instanceof DownstreamBusyError ? 503 : 502);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      releaseSmtp?.();
    }
  },
};
