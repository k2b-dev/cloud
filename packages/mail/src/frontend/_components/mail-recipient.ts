import { type MailAddress, type MailDraft, mailAddressSchema } from "../../contracts";

const angleAddressPattern = /^(.*?)\s*<([^<>]+)>$/;

/** A name with a list separator keeps its quotes, so the pill can be edited and committed again unchanged. */
export const formatMailRecipient = (recipient: MailAddress): string =>
  recipient.name ? `${/[,;]/.test(recipient.name) ? `"${recipient.name}"` : recipient.name} <${recipient.address}>` : recipient.address;

export const formatMailRecipients = (recipients: MailDraft["to"]): string[] => recipients.map(formatMailRecipient);

export const parseMailRecipient = (value: string): MailAddress | null => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const match = normalized.match(angleAddressPattern);
  const address = (match?.[2] ?? normalized).trim().toLowerCase();
  const name = match?.[1]?.trim().replace(/^"|"$/g, "") || null;
  const parsed = mailAddressSchema.safeParse({ name, address });
  return parsed.success ? parsed.data : null;
};

export const parseMailRecipients = (values: string[]): MailAddress[] => {
  const recipients = new Map<string, MailAddress>();
  for (const value of values) {
    const recipient = parseMailRecipient(value);
    if (!recipient) continue;
    const existing = recipients.get(recipient.address);
    recipients.set(recipient.address, existing?.name && !recipient.name ? existing : recipient);
  }
  return [...recipients.values()];
};

/** True while a quote or an angle bracket in `value` is still open. */
const opensGroup = (value: string): boolean => {
  let quoted = false;
  let angled = false;
  for (const character of value) {
    if (character === '"' && !angled) quoted = !quoted;
    else if (character === "<" && !quoted) angled = true;
    else if (character === ">" && !quoted) angled = false;
  }
  return quoted || angled;
};

/**
 * Splits pasted or typed text at commas, semicolons, and line breaks. A comma inside a quoted name
 * (`"Kolb, Bernd" <b@example.test>`) or inside angle brackets stays part of its address.
 */
export const splitMailRecipients = (raw: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const character of raw) {
    if (character === '"' && !angled) quoted = !quoted;
    else if (character === "<" && !quoted) angled = true;
    else if (character === ">" && !quoted) angled = false;
    if (!quoted && !angled && (character === "," || character === ";" || character === "\n" || character === "\r")) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};

/**
 * Adds every valid address in `raw`, or replaces the pill at `index` with the first one. Text that is not an
 * address comes back as `rest`, so the field keeps it for correction instead of dropping it.
 */
export const commitMailRecipients = (values: string[], raw: string, index: number | null = null): { values: string[]; rest: string } => {
  const parts = splitMailRecipients(raw);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const recipient = parseMailRecipient(part);
    if (recipient) valid.push(formatMailRecipient(recipient));
    else invalid.push(part);
  }
  if (valid.length === 0) return { values, rest: invalid.join(", ") };
  const candidates =
    index === null ? [...values, ...valid] : values.flatMap((value, candidateIndex) => (candidateIndex === index ? valid : [value]));
  return { values: parseMailRecipients(candidates).map(formatMailRecipient), rest: invalid.join(", ") };
};

export const shouldCommitMailRecipient = (value: string, key: string): boolean => {
  if (!value.trim()) return false;
  if (key === "Enter") return true;
  // Inside a quoted name ("Kolb, Bernd") or an address in brackets, a separator is text.
  if (key === "," || key === ";") return !opensGroup(value);
  return key === " " && parseMailRecipient(value) !== null;
};
