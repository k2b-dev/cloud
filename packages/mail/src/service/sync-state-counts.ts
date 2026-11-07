/** Count each resource's disjoint running/recent sets through its existing indexes. */
export const mailboxSyncStateCountsQuery = `
  SELECT states.state, SUM(states.count)::int AS count
  FROM mail.remote_resources resource
  CROSS JOIN LATERAL (
    SELECT run.state, COUNT(*)::int AS count
    FROM mail.sync_runs run
    WHERE run.remote_resource_id = resource.id AND run.state = 'running'
    GROUP BY run.state
    UNION ALL
    SELECT run.state, COUNT(*)::int AS count
    FROM mail.sync_runs run
    WHERE run.remote_resource_id = resource.id AND run.state <> 'running'
      AND run.started_at > now() - $2::int * interval '1 hour'
    GROUP BY run.state
  ) states
  WHERE resource.mailbox_id = $1::uuid
  GROUP BY states.state
`;
