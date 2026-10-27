import type { sql } from "bun";

/** Additions shared by startup and schema fixtures; all statements are idempotent. */
export const migrateConversationSummaries = async (db: typeof sql): Promise<void> => {
  await db`ALTER TABLE mail.conversations ADD COLUMN IF NOT EXISTS summary_metadata jsonb NOT NULL DEFAULT '{}'::jsonb`;
  // Older writers recorded the actor and exact summary revision in activity, including clears.
  await db`WITH latest AS (
    SELECT DISTINCT ON (a.conversation_id) a.conversation_id, a.actor_kind, a.actor_id, a.created_at,
      a.metadata->'after'->>'summaryRevision' AS summary_revision
    FROM mail.activity_events a
    WHERE a.action = 'conversation.summary_updated' AND a.outcome = 'confirmed'
      AND a.metadata->'after'->>'summaryRevision' IS NOT NULL
    ORDER BY a.conversation_id, a.id DESC
  ) UPDATE mail.conversations c SET summary_metadata = jsonb_build_object(
      'source', CASE WHEN a.actor_kind = 'workflow' THEN 'workflow' ELSE 'person' END,
      'author', CASE
        WHEN a.actor_kind = 'workflow' AND w.id IS NOT NULL
          THEN jsonb_build_object('kind','workflow','id',w.id,'name',w.name)
        WHEN u.id IS NOT NULL THEN jsonb_build_object('kind','user','id',u.id,'name',COALESCE(NULLIF(u.display_name,''),u.uid))
        ELSE NULL END,
      'ai', false, 'generatedAt', a.created_at)
    FROM latest a
    LEFT JOIN workflows.version v ON a.actor_kind = 'workflow' AND v.id = a.actor_id
    LEFT JOIN workflows.workflow w ON w.id = v.workflow_id
    LEFT JOIN auth.service_accounts sa ON a.actor_kind = 'service_account' AND sa.id = a.actor_id
    LEFT JOIN auth.users u ON u.id = CASE WHEN a.actor_kind = 'user' THEN a.actor_id ELSE sa.delegated_user_id END
    WHERE c.id = a.conversation_id AND c.summary_metadata = '{}'::jsonb
      AND a.summary_revision = c.summary_revision::text`;
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
