/**
 * Creating a workflow in a test, the way the app creates one now.
 *
 * A workflow is three rows: identity and an immutable version in the kernel,
 * and the Grids profile that scopes it to a base. Tests used to write a single
 * `grids.workflows` row, so this exists to keep that convenience without
 * pretending the table is still there.
 *
 * Raw SQL rather than the store, because fixtures need to pin ids and skip
 * compilation — a test asserting run behaviour should not also depend on its
 * source compiling.
 */
import { deleteWorkflowScope } from "@valentinkolb/cloud/workflows/store";
import { type SQL, sql } from "bun";
import { GRIDS_EVENT } from "../workflows/events";
import { GRIDS_APP_ID } from "./workflow-runs";

const hex = (seed: string) => new Bun.CryptoHasher("sha256").update(seed).digest("hex");

let counter = 0;
/** Six alphanumerics, unique per call — the public profile ID contract. */
const nextShortId = (): string => {
  counter += 1;
  return `T${counter.toString(36).toUpperCase().padStart(5, "0")}`.slice(0, 6);
};

type TestWorkflowInput = {
  baseId: string;
  /** The connection the fixture belongs to — migration tests use an isolated one. */
  db?: SQL;
  id?: string;
  name?: string;
  shortId?: string;
  source?: string;
  /** Defaults to an empty bound plan, which is enough for anything not executing it. */
  plan?: Record<string, unknown>;
  diagnostics?: unknown[];
  enabled?: boolean;
  position?: number;
  ownerUserId?: string | null;
  recordEventActiveSince?: Date | null;
};

const EMPTY_PLAN = {
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: hex("fixture"),
  manifestHash: hex("fixture-manifest"),
  catalogHash: hex("fixture-catalog"),
  maxLoopItems: 10_000,
  actionPolicies: {},
  inputs: [],
  triggers: [],
  steps: [],
  bindings: {},
};

/**
 * The activations every Grids workflow has, whatever its source declares.
 *
 * `activationsFor` adds these unconditionally because being runnable directly
 * and from a launcher is not a trigger anyone wrote. Without them an
 * invocation matches nothing and the run a test waits for is never created,
 * which is a silent pass rather than a failure — so the fixture writes them
 * too, and re-points them at each new version the way a publish does.
 */
const repointInvocationActivations = async (db: SQL, workflowId: string, versionId: string): Promise<void> => {
  await db`
    INSERT INTO workflows.activation (workflow_id, workflow_version_id, key, event_type, authorization_snapshot, enabled)
    SELECT ${workflowId}::uuid, ${versionId}::uuid, activation.key, activation.event_type, '{}'::jsonb, profile.enabled
    FROM (VALUES ('invoked', ${GRIDS_EVENT.invoked}), ('launcher', ${GRIDS_EVENT.launcherPressed})) AS activation(key, event_type)
    JOIN grids.workflow_profile AS profile ON profile.id = ${workflowId}::uuid
    ON CONFLICT (workflow_id, key) DO UPDATE
    SET workflow_version_id = EXCLUDED.workflow_version_id, enabled = EXCLUDED.enabled, updated_at = now()
  `;
};

/** Returns the workflow id, which is the kernel's and the profile's alike. */
export const insertTestWorkflow = async (input: TestWorkflowInput): Promise<string> => {
  const db = input.db ?? sql;
  const id = input.id ?? Bun.randomUUIDv7();
  const source = input.source ?? "steps: []";
  const plan = input.plan ?? EMPTY_PLAN;

  await db`
    INSERT INTO workflows.workflow (id, app_id, scope_id, key, name, created_by_kind)
    VALUES (${id}::uuid, 'grids', ${input.baseId}, ${id}, ${input.name ?? "Test workflow"}, 'system')
    ON CONFLICT (id) DO NOTHING
  `;
  const [version] = await db<Array<{ id: string }>>`
    INSERT INTO workflows.version (
      workflow_id, revision, source, source_hash, plan, diagnostics, language_id, language_version, manifest_hash, created_by_kind
    )
    SELECT ${id}::uuid, COALESCE(max(revision), 0) + 1, ${source}, ${hex(source)}, ${plan}, ${input.diagnostics ?? []},
           'grids', 1, ${hex("fixture-manifest")}, 'system'
    FROM workflows.version WHERE workflow_id = ${id}::uuid
    RETURNING id::text AS id
  `;
  if (!version) throw new Error("test workflow version insert returned no row");
  await db`
    UPDATE workflows.workflow
    SET active_version_id = ${version.id}::uuid, updated_at = now()
    WHERE id = ${id}::uuid
  `;
  await db`
    INSERT INTO grids.workflow_profile (id, base_id, short_id, position, owner_user_id, enabled, record_event_active_since)
    VALUES (
      ${id}::uuid, ${input.baseId}::uuid, ${input.shortId ?? nextShortId()}, ${input.position ?? 0},
      ${input.ownerUserId ?? null}::uuid, ${input.enabled ?? false}, ${input.recordEventActiveSince ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, position = EXCLUDED.position
  `;
  await repointInvocationActivations(db, id, version.id);
  return id;
};

/** Publishes another version, the way saving a changed source does. */
export const publishTestWorkflowVersion = async (id: string, source: string, plan?: Record<string, unknown>): Promise<number> => {
  const [row] = await sql<Array<{ id: string; revision: number }>>`
    INSERT INTO workflows.version (
      workflow_id, revision, source, source_hash, plan, diagnostics, language_id, language_version, manifest_hash, created_by_kind
    )
    SELECT ${id}::uuid, COALESCE(max(revision), 0) + 1, ${source}, ${hex(source)}, ${plan ?? EMPTY_PLAN}, '[]'::jsonb,
           'grids', 1, ${hex("fixture-manifest")}, 'system'
    FROM workflows.version WHERE workflow_id = ${id}::uuid
    RETURNING id::text AS id, revision
  `;
  if (!row) throw new Error("test workflow version insert returned no row");
  await sql`
    UPDATE workflows.workflow
    SET active_version_id = ${row.id}::uuid, updated_at = now()
    WHERE id = ${id}::uuid
  `;
  await repointInvocationActivations(sql, id, row.id);
  return row.revision;
};

/** Soft-deletes it the way removeWorkflow does. */
export const deleteTestWorkflow = async (id: string): Promise<void> => {
  await sql`
    UPDATE grids.workflow_profile SET deleted_at = now(), enabled = FALSE, record_event_active_since = NULL WHERE id = ${id}::uuid
  `;
};

/**
 * Drops everything the kernel holds for one base.
 *
 * Deleting `grids.bases` cascades the Grids profile, but nothing in the kernel
 * references a Grids table — deliberately, so the kernel does not depend on its
 * apps. A test that only drops its base therefore leaves the workflow, its
 * versions, activations, events and runs behind in a database every other test
 * shares, and they accumulate run after run.
 */
export const deleteTestWorkflowScope = async (baseId: string): Promise<void> => {
  await deleteWorkflowScope({ appId: GRIDS_APP_ID, scopeId: baseId });
};

type TestWorkflowRunInput = {
  workflowId: string;
  baseId: string;
  db?: SQL;
  id?: string;
  shortId?: string;
  mode?: "execute" | "dryRun";
  /** Grids' own label for how the run was started. */
  channel?: "api" | "Grids App" | "scanner" | "bulk" | "schedule" | "recordEvent";
  state?: "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "needs_attention";
  launcherId?: string | null;
  actorUserId?: string | null;
  serviceAccountId?: string | null;
  authorization?: Record<string, unknown>;
  idempotencyKey?: string;
  occurredAt?: Date;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

/**
 * A run as the kernel and Grids together record one.
 *
 * Two rows: the kernel's, pinned to the workflow's newest version, and the
 * profile the run list filters and labels by. Written directly rather than
 * through the service, because a test about reading runs should not have to
 * execute one — and every one of these would otherwise restate the join
 * between the two tables.
 */
export const insertTestWorkflowRun = async (input: TestWorkflowRunInput): Promise<string> => {
  const db = input.db ?? sql;
  const id = input.id ?? Bun.randomUUIDv7();
  const createdAt = input.createdAt ?? new Date();
  /*
   * A `running` row with no lease is exactly what a crashed run looks like, so
   * any worker sharing this database — the dev container's included — is right
   * to recover it, and does so within about a second. Hold a lease so the state
   * the fixture wrote is the state the assertion reads.
   */
  const running = (input.state ?? "queued") === "running";
  const leaseOwner = running ? "test-fixture" : null;
  const leaseExpiresAt = running ? new Date(Date.now() + 60 * 60_000) : null;
  await db`
    INSERT INTO workflows.run (
      id, app_id, scope_id, workflow_id, workflow_version_id, mode, state, inputs, context,
      authorization_snapshot, idempotency_key, occurred_at, created_at, started_at, finished_at,
      lease_owner, lease_expires_at
    )
    SELECT ${id}::uuid, 'grids', ${input.baseId}, ${input.workflowId}::uuid, version.id,
           ${input.mode ?? "execute"}, ${input.state ?? "queued"}, '{}'::jsonb, '{}'::jsonb,
           ${input.authorization ?? { kind: "workflow" }}, ${input.idempotencyKey ?? id},
           ${input.occurredAt ?? createdAt}, ${createdAt}, ${input.startedAt ?? null}, ${input.finishedAt ?? null},
           ${leaseOwner}, ${leaseExpiresAt}
    FROM workflows.version AS version
    WHERE version.workflow_id = ${input.workflowId}::uuid
    ORDER BY version.revision DESC
    LIMIT 1
  `;
  await db`
    INSERT INTO grids.workflow_run_profile (
      run_id, short_id, base_id, workflow_id, launcher_id, channel, actor_user_id, service_account_id, request_fingerprint
    ) VALUES (
      ${id}::uuid, ${input.shortId ?? nextShortId()}, ${input.baseId}::uuid, ${input.workflowId}::uuid, ${input.launcherId ?? null}::uuid,
      ${input.channel ?? "api"}, ${input.actorUserId ?? null}::uuid, ${input.serviceAccountId ?? null}::uuid, ${id}
    )
  `;
  return id;
};
