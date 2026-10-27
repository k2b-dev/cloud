import type { sql } from "bun";

/** Additions shared by startup and schema fixtures; all statements are idempotent. */
export const migrateConversationSummaries = async (db: typeof sql): Promise<void> => {
  await db`ALTER TABLE mail.conversations ADD COLUMN IF NOT EXISTS summary_metadata jsonb NOT NULL DEFAULT '{}'::jsonb`;
  await db`
    CREATE TABLE IF NOT EXISTS mail.conversation_summary_requests (
      conversation_id uuid PRIMARY KEY REFERENCES mail.conversations(id) ON DELETE CASCADE,
      mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      request_id uuid NOT NULL,
      request jsonb NOT NULL,
      basis jsonb,
      status text NOT NULL CHECK (status IN ('pending','writing','idle','failed','limited')),
      due_at timestamptz NOT NULL,
      claim_id uuid,
      claimed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      failure jsonb,
      limit_info jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS conversation_summary_requests_due_idx
    ON mail.conversation_summary_requests (due_at, conversation_id) WHERE status IN ('pending','writing')`;
};
