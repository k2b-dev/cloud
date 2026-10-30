ALTER TABLE reports ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 1024 CHECK(storage_bytes>=0);
ALTER TABLE moderation_log ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 512 CHECK(storage_bytes>=0);
ALTER TABLE admin_sessions ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 256 CHECK(storage_bytes>=0);
ALTER TABLE reports ADD COLUMN notification_state text NOT NULL DEFAULT 'none' CHECK(notification_state IN ('none','pending','sent'));
ALTER TABLE reports ADD COLUMN notification_sent_at timestamptz;
CREATE INDEX pads_pending_cleanup ON pads(read_id)
WHERE (deleted_at IS NOT NULL OR blocked_at IS NOT NULL)
  AND (size_bytes<>256+octet_length(COALESCE(status_reason,'')) OR octet_length(snapshot)>0);
