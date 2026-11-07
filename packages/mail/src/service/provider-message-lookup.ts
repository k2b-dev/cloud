/** Literal JSON key matches generic plans. Hashing bounds the index key even for malformed
 * provider IDs already stored; the original equality rechecks collisions without changing identity. */
export const providerMessageLookupQuery = `
  SELECT DISTINCT remote_ref.message_id
  FROM mail.remote_message_refs remote_ref
  JOIN mail.folders folder ON folder.id = remote_ref.folder_id
  WHERE folder.remote_resource_id = $1::uuid
    AND md5(remote_ref.connector_ref ->> 'providerMessageId') = md5($2::text)
    AND remote_ref.connector_ref ->> 'providerMessageId' = $2
  ORDER BY remote_ref.message_id
  LIMIT 2
`;
