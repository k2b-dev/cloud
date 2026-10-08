import { z } from "zod";

export const DSN_PART_BYTES = 64 * 1024;
export const BOUNCE_FAILURE_LIMIT = 100;
export type BounceStructure = {
  type: string;
  part?: string;
  parameters?: Record<string, string>;
  childNodes?: BounceStructure[];
};
export type DeliveryReport = { messageId: string; failures: { recipient: string; reason: string }[] };

/** Select only the report and original headers, never the returned message body. */
export const dsnParts = (structure: BounceStructure) => {
  if (
    structure.type.toLowerCase() !== "multipart/report" ||
    Object.entries(structure.parameters ?? {})
      .find(([name]) => name.toLowerCase() === "report-type")?.[1]
      .toLowerCase() !== "delivery-status"
  )
    return null;
  const nodes = structure.childNodes ?? [];
  const status = nodes.find((node) => node.type.toLowerCase() === "message/delivery-status")?.part;
  const original = nodes.find((node) => ["text/rfc822-headers", "message/rfc822"].includes(node.type.toLowerCase()));
  if (!status || !original?.part) return null;
  return { status, headers: original.type.toLowerCase() === "message/rfc822" ? `${original.part}.HEADER` : original.part };
};
const fields = (block: string) => {
  const result = new Map<string, string>();
  for (const line of block.replace(/\r?\n[\t ]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) result.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return result;
};
export const parseDsn = (status: string, headers: string, fromAddress: string): DeliveryReport | null => {
  if (Buffer.byteLength(status) > DSN_PART_BYTES || Buffer.byteLength(headers) > DSN_PART_BYTES) return null;
  const messageId = fields(headers.split(/\r?\n\r?\n/, 1)[0] ?? "").get("message-id");
  const match = messageId?.match(/^<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([^<>\s@]+)>$/i);
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);
  if (!match || !z.uuid().safeParse(match[1]).success || match[2]?.toLowerCase() !== domain.toLowerCase()) return null;
  const failures: DeliveryReport["failures"] = [];
  // RFC 3464 begins with one per-message block followed by per-recipient blocks.
  for (const block of status.split(/\r?\n[\t ]*\r?\n/).slice(1)) {
    const entry = fields(block);
    if (entry.get("action")?.toLowerCase() !== "failed") continue;
    const final = entry.get("final-recipient")?.match(/^rfc822\s*;\s*(.+)$/i);
    const recipient = final?.[1]?.trim();
    const code = entry.get("status");
    if (!recipient || !z.email().max(320).safeParse(recipient).success || !code || !/^[245]\.\d{1,3}\.\d{1,3}$/.test(code)) continue;
    const reason = `${code} ${entry.get("diagnostic-code") ?? ""}`.trim().slice(0, 1000);
    if (!failures.some((item) => item.recipient === recipient && item.reason === reason)) failures.push({ recipient, reason });
    if (failures.length === BOUNCE_FAILURE_LIMIT) break;
  }
  // Generated outgoing-mail IDs use lowercase UUIDs and the profile's sender domain.
  return failures.length ? { messageId: `<${match[1]?.toLowerCase()}@${domain}>`, failures } : null;
};
