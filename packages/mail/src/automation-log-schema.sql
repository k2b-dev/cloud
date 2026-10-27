CREATE TABLE IF NOT EXISTS mail.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES mail.conversations(id) ON DELETE SET NULL,
  run_id uuid REFERENCES workflows.run(id) ON DELETE SET NULL,
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  chain jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(chain) = 'array'),
  assignment_user_id uuid,
  undone_by_id text,
  undone_by_name text,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS automation_log_mailbox_date_idx ON mail.automation_log (mailbox_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS automation_log_conversation_date_idx ON mail.automation_log (conversation_id, created_at DESC, id DESC);
-- A person changing assignment invalidates provenance even if they restore the same person later.
CREATE TABLE IF NOT EXISTS mail.automation_assignment (
  conversation_id uuid PRIMARY KEY REFERENCES mail.conversations(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  user_id uuid NOT NULL,
  changed_by_id text,
  changed_by_name text,
  changed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- This small semantic marker outlives the audit's 30-day retention window.
CREATE TABLE IF NOT EXISTS mail.automation_assignment_undone (
  conversation_id uuid NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows.workflow(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, workflow_id)
);

ALTER TABLE mail.workflow_run_state ADD COLUMN IF NOT EXISTS audit_updated_at timestamptz;
