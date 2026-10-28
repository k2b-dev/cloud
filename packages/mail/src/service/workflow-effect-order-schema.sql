-- Frozen messageReceived delivery order. Apply to baseline + idempotent additions.
CREATE TABLE IF NOT EXISTS mail.workflow_effect_order (
    event_id uuid PRIMARY KEY REFERENCES workflows.event(id) ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    remote_message_ref_id uuid NOT NULL REFERENCES mail.remote_message_refs(id) ON DELETE CASCADE,
    workflow_id uuid NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    workflow_name text NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (remote_message_ref_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS workflow_effect_order_message_position_idx
    ON mail.workflow_effect_order (remote_message_ref_id, position);
CREATE INDEX IF NOT EXISTS workflow_effect_order_retention_idx ON mail.workflow_effect_order (created_at, event_id);

CREATE TABLE IF NOT EXISTS mail.workflow_effect_claim (
    remote_message_ref_id uuid NOT NULL REFERENCES mail.remote_message_refs(id) ON DELETE CASCADE,
    effect_class text NOT NULL CHECK (effect_class IN ('assignment', 'placement', 'status')),
    event_id uuid NOT NULL REFERENCES mail.workflow_effect_order(event_id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES workflows.run(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (remote_message_ref_id, effect_class)
);
