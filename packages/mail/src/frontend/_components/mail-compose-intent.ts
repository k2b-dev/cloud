import type { MailAddress } from "../../contracts";
import { parseMailRecipient } from "./mail-recipient";

const MAX_MAILTO_LENGTH = 32 * 1024;
const MAX_BODY_LENGTH = 24 * 1024;
const MAX_RECIPIENTS = 200;

type MailComposeIntent = {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
};

export type MailComposeIntentErrorCode =
  | "too_large"
  | "invalid_link"
  | "invalid_encoding"
  | "duplicate_field"
  | "subject_too_long"
  | "body_too_long"
  | "too_many_to"
  | "too_many_cc"
  | "too_many_bcc"
  | "invalid_to"
  | "invalid_cc"
  | "invalid_bcc";

type MailComposeIntentResult = { ok: true; intent: MailComposeIntent } | { ok: false; code: MailComposeIntentErrorCode };

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const splitRecipients = (values: string[]): string[] =>
  values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

const parseRecipients = (
  values: string[],
  codes: { tooMany: MailComposeIntentErrorCode; invalid: MailComposeIntentErrorCode },
): MailAddress[] | MailComposeIntentErrorCode => {
  const recipients = splitRecipients(values);
  if (recipients.length > MAX_RECIPIENTS) return codes.tooMany;
  const parsed = recipients.map(parseMailRecipient);
  if (parsed.some((recipient) => recipient === null)) return codes.invalid;
  const unique = new Map<string, MailAddress>();
  for (const recipient of parsed as MailAddress[]) unique.set(recipient.address.toLowerCase(), recipient);
  return [...unique.values()];
};

const singleHeader = (headers: Map<string, string[]>, name: string): string | null | undefined => {
  const values = headers.get(name) ?? [];
  if (values.length > 1) return undefined;
  return values[0] ?? null;
};

const parseHeaders = (rawQuery: string): { ok: true; headers: Map<string, string[]> } | { ok: false } => {
  const headers = new Map<string, string[]>();
  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const rawName = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    const name = decode(rawName)?.trim().toLowerCase();
    const value = decode(rawValue);
    if (!name || value === null) return { ok: false };
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return { ok: true, headers };
};

const parseContent = (
  headers: Map<string, string[]>,
): { ok: true; subject: string; body: string } | { ok: false; code: MailComposeIntentErrorCode } => {
  const subject = singleHeader(headers, "subject");
  const body = singleHeader(headers, "body");
  if (subject === undefined || body === undefined) {
    return { ok: false, code: "duplicate_field" };
  }
  const normalizedSubject = (subject ?? "").replaceAll(/[\r\n]+/g, " ").trim();
  const normalizedBody = (body ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalizedSubject.length > 998) return { ok: false, code: "subject_too_long" };
  if (normalizedBody.length > MAX_BODY_LENGTH) return { ok: false, code: "body_too_long" };
  return { ok: true, subject: normalizedSubject, body: normalizedBody };
};

const parseRecipientFields = (
  path: string,
  headers: Map<string, string[]>,
): { ok: true; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] } | { ok: false; code: MailComposeIntentErrorCode } => {
  const to = parseRecipients([path, ...(headers.get("to") ?? [])], { tooMany: "too_many_to", invalid: "invalid_to" });
  const cc = parseRecipients(headers.get("cc") ?? [], { tooMany: "too_many_cc", invalid: "invalid_cc" });
  const bcc = parseRecipients(headers.get("bcc") ?? [], { tooMany: "too_many_bcc", invalid: "invalid_bcc" });
  if (typeof to === "string") return { ok: false, code: to };
  if (typeof cc === "string") return { ok: false, code: cc };
  if (typeof bcc === "string") return { ok: false, code: bcc };
  return { ok: true, to, cc, bcc };
};

const emptyMailComposeIntent = (): MailComposeIntent => ({
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
});

export const parseMailtoIntent = (value: string | null | undefined): MailComposeIntentResult => {
  if (!value) return { ok: true, intent: emptyMailComposeIntent() };
  if (value.length > MAX_MAILTO_LENGTH) return { ok: false, code: "too_large" };
  if (!value.toLowerCase().startsWith("mailto:")) return { ok: false, code: "invalid_link" };

  const source = value.slice("mailto:".length);
  const separator = source.indexOf("?");
  const rawPath = separator === -1 ? source : source.slice(0, separator);
  const rawQuery = separator === -1 ? "" : source.slice(separator + 1);
  const path = decode(rawPath);
  if (path === null) return { ok: false, code: "invalid_encoding" };

  const parsedHeaders = parseHeaders(rawQuery);
  if (!parsedHeaders.ok) return { ok: false, code: "invalid_encoding" };
  const content = parseContent(parsedHeaders.headers);
  if (!content.ok) return content;
  const recipients = parseRecipientFields(path, parsedHeaders.headers);
  if (!recipients.ok) return recipients;

  return {
    ok: true,
    intent: {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: content.subject,
      body: content.body,
    },
  };
};
