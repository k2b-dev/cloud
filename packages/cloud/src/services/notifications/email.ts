import sanitizeHtml from "sanitize-html";
import { sanitizeEmailHtml } from "../../shared";
import { resolveMailCredentials } from "../outgoing-mail/store";
import { buildMailTransport } from "../outgoing-mail/transport";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";

/** Sanitize plain text content (no HTML allowed). */
const sanitizeContent = (content: string): string => sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });

/** Send an email with the standard HTML template. */
export const sendEmail = async (
  to: string,
  subject: string,
  opts: { content?: string; rawHtml?: string; messageId?: string },
): Promise<void> => {
  const rawAppUrl = await settings.get<string>("app.url");
  const appUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  const appName = await settings.get<string>("app.name");
  const profile = await resolveMailCredentials();

  let body = "";
  if (opts.rawHtml) {
    body = sanitizeEmailHtml(opts.rawHtml);
  } else if (opts.content) {
    body = `<p>${sanitizeContent(opts.content)}</p>`;
  }
  const text = opts.content ? sanitizeContent(opts.content) : undefined;

  const html = await buildHtml(appUrl, appName, body);
  const transporter = buildMailTransport(profile);

  try {
    await transporter.sendMail({
      from: { address: profile.fromAddress, name: profile.fromName ?? appName },
      to,
      subject,
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
      html,
      ...(text ? { text } : {}),
    });
  } finally {
    transporter.close();
  }
};

/**
 * Builds the default HTML mail template wrapper when no raw HTML was provided.
 */
const buildHtml = async (appUrl: string, appName: string, content: string) => {
  const logoUri = await coreSettings.get<string>("app.logo");
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">

        <!-- Header -->
        <tr><td style="background:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0;border:1px solid #e4e4e7;border-bottom:none;">
          <table cellpadding="0" cellspacing="0"><tr>
          ${
            logoUri
              ? `<td style="padding-right:12px;vertical-align:middle;">
              <img src="${logoUri}" alt="Logo" width="28" height="28" style="display:block;">
            </td>`
              : ""
          }
            <td style="vertical-align:middle;">
              <span style="font-size:16px;font-weight:600;color:#18181b;">${appName}</span>
            </td>
          </tr></table>
        </td></tr>

        <!-- Content -->
        <tr><td style="background:#ffffff;padding:28px 24px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7;">
          <div style="font-size:14px;line-height:1.6;color:#27272a;">
            ${content}
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#fafafa;padding:16px 24px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
          <p style="margin:0 0 8px;font-size:11px;color:#71717a;text-align:center;">
            <a href="${appUrl}/impressum" style="color:#71717a;text-decoration:underline;">Imprint</a>
            &nbsp;&middot;&nbsp;
            <a href="${appUrl}/legal/terms" style="color:#71717a;text-decoration:underline;">Terms</a>
            &nbsp;&middot;&nbsp;
            <a href="${appUrl}/legal/privacy" style="color:#71717a;text-decoration:underline;">Privacy</a>
          </p>
          <p style="margin:0;font-size:11px;color:#a1a1aa;text-align:center;">
            This message was sent automatically. Please do not reply to this email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
<!-- the answer is 42 ;D -->
</html>
`;
};
