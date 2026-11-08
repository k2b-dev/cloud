import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SenderMatchKind } from "../contracts";
import { normalizeEmailAddress, normalizeEmailDomain } from "./address-normalization";

type SqlClient = typeof sql;
export const normalizeSenderMatch = (kind: SenderMatchKind, value: string): Result<string> => {
  const normalized = kind === "sender" ? normalizeEmailAddress(value) : normalizeEmailDomain(value);
  if (!normalized) return fail(err.badInput(kind === "sender" ? "Enter a valid sender email address" : "Enter a valid sender domain"));
  if (kind === "domain" && !normalized.includes(".")) {
    return fail(err.badInput("Enter a complete sender domain, for example example.com"));
  }
  return ok(normalized);
};

const senderMatchSql = (kind: SenderMatchKind, value: string) =>
  kind === "sender" ? sql`sender.normalized_email = ${value}` : sql`substring(sender.normalized_email from '@([^@]*)$') = ${value}`;
type SqlFragment = ReturnType<typeof senderMatchSql>;

const firstFromAddress = () => sql`sender.position = (
  SELECT min(first_sender.position) FROM mail.message_addresses first_sender
  WHERE first_sender.message_id = message.id AND first_sender.role = 'from'
)`;

const externalSender = () => sql`
  NOT EXISTS (
    SELECT 1
    FROM mail.sender_identities identity
    WHERE identity.mailbox_id = resource.mailbox_id
      AND lower(identity.from_address) = sender.normalized_email
      AND identity.status <> 'disabled'
  )
`;

/** Sender predicate over the shared bulk selector's message and resource aliases. */
export const senderMatchesSql = (kind: SenderMatchKind, value: string): SqlFragment => sql`EXISTS (
  SELECT 1 FROM mail.message_addresses sender
  WHERE sender.message_id = message.id AND sender.role = 'from'
    AND ${firstFromAddress()}
    AND ${externalSender()}
    AND ${senderMatchSql(kind, value)}
)`;

export const rejectOwnSenderTargets = async (params: {
  mailboxId: string;
  match: SenderMatchKind;
  value: string;
  db: SqlClient;
  message?: string;
}): Promise<Result<void>> => {
  if (params.match !== "sender") return ok();
  const [identity] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.sender_identities
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND lower(from_address) = ${params.value}
      AND status <> 'disabled'
    LIMIT 1
  `;
  return identity
    ? fail(err.badInput(params.message ?? "Choose an external sender; this address is one of the mailbox's own sender addresses"))
    : ok();
};
