import { audit } from "../audit";
import { get } from "../settings";
import { type MailAuditContext, OutgoingMailError, resolveMailCredentials } from "./store";
import { buildMailTransport } from "./transport";

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
    const transport = buildMailTransport(profile);
    try {
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
      throw new OutgoingMailError("smtp_failed", message, 502);
    } finally {
      transport.close();
    }
  },
};
