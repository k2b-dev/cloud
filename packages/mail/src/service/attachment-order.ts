import { sql } from "bun";

/**
 * Orders `mail.attachments attachment` joined with its `mail.message_parts part` in MIME order.
 * Part paths are dot-separated part numbers ("2", "1.3", "10") or generated labels ending in a
 * position ("outbound-attachment-10"), so their numbers are compared as numbers rather than as text.
 */
export const attachmentMimeOrder = sql`
  ARRAY(
    SELECT digits[1]::numeric
    FROM regexp_matches(part.part_path, '[0-9]+', 'g') WITH ORDINALITY AS part_number(digits, ordinal)
    ORDER BY ordinal
  ),
  part.part_path,
  attachment.id
`;
