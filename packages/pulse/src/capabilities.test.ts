import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  type CapabilityQueryDefinition,
  capabilityResultSchema,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { sql } from "bun";
import { pulseCapabilities } from "./capabilities";
import {
  BaseListDataSchema,
  BaseReadInputSchema,
  ResourceReadInputSchema,
  SavedQueryReadInputSchema,
  SourceReadInputSchema,
} from "./capability-contracts";
import { newShortId } from "./lib/short-id";

const userContext = (user: User): CapabilityExecutionContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  signal: new AbortController().signal,
});

const testUser = (id: string, suffix: string): User => ({
  id,
  uid: `pulse-capability-${suffix}`,
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Pulse",
  sn: "Capability",
  displayName: "Pulse Capability",
  mail: `pulse-capability-${suffix}@example.test`,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

const invoke = (localId: string, input: unknown, context: CapabilityExecutionContext) => {
  const operation = (pulseCapabilities.queries as unknown as Readonly<Record<string, CapabilityQueryDefinition>>)[localId];
  if (!operation) throw new Error(`Missing Pulse capability ${localId}`);
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid test input for ${localId}: ${parsed.error.message}`);
  return Promise.resolve(operation.run(parsed.data, context)).then((result) => {
    if (result.ok) {
      const validated = capabilityResultSchema(operation.data).safeParse(result.data);
      if (!validated.success) throw new Error(`Invalid test result for ${localId}: ${validated.error.message}`);
    }
    return result;
  });
};

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ bases: string | null; users: string | null }[]>`
      SELECT to_regclass('pulse.bases')::text AS bases, to_regclass('auth.users')::text AS users
    `;
    return Boolean(row?.bases && row.users);
  } catch {
    return false;
  }
};

const databaseAvailable = await canUseDatabase();
if (databaseAvailable) setDefaultTimeout(60_000);
const postgresTest = databaseAvailable ? test : test.skip;

describe("Pulse capabilities", () => {
  test("declares and compiles the curated read-only v1 surface", () => {
    expect(pulseCapabilities.protocolVersion).toBe(1);
    expect(Object.keys(pulseCapabilities.types ?? {}).sort()).toEqual(["base", "resource", "saved_query", "source"]);
    expect(Object.keys(pulseCapabilities.queries ?? {}).sort()).toEqual([
      "base.list",
      "base.read",
      "base.search",
      "field.search",
      "metric.search",
      "query.compile",
      "query.execute",
      "resource.read",
      "resource.search",
      "saved_query.execute",
      "saved_query.list",
      "saved_query.read",
      "source.list",
      "source.read",
    ]);
    expect("actions" in pulseCapabilities).toBe(false);

    expect(pulseCapabilities.queries?.["base.search"]?.input).toBe(UniversalSearchInputSchema);
    expect(pulseCapabilities.queries?.["base.search"]?.data).toBe(UniversalSearchDataSchema);
    expect(pulseCapabilities.queries?.["resource.search"]?.input).toBe(UniversalSearchInputSchema);
    expect(pulseCapabilities.queries?.["resource.search"]?.data).toBe(UniversalSearchDataSchema);
    const uuid = crypto.randomUUID();
    expect(BaseReadInputSchema.safeParse({ id: uuid }).success).toBe(false);
    expect(SourceReadInputSchema.safeParse({ id: uuid }).success).toBe(false);
    expect(SavedQueryReadInputSchema.safeParse({ id: uuid }).success).toBe(false);
    expect(ResourceReadInputSchema.safeParse({ id: uuid }).success).toBe(false);
    expect(
      pulseCapabilities.queries?.["query.execute"]?.input.safeParse({ baseId: crypto.randomUUID(), query: "states *", extra: true })
        .success,
    ).toBe(false);
    expect(pulseCapabilities.queries?.["base.list"]?.description).toContain("Normal entry for Base-scoped telemetry work");
    expect(pulseCapabilities.queries?.["resource.search"]?.description).toContain("Direct cross-Base entry");
    expect(pulseCapabilities.queries?.["query.execute"]?.description).toContain("normally after query.compile");
    expect(pulseCapabilities.queries?.["saved_query.execute"]?.description).toContain("skips query.compile");
    expect(
      BaseListDataSchema.safeParse([
        {
          id: "Base01",
          ref: { type: "pulse.base", id: "Base01" },
          name: "Telemetry",
          description: null,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
          links: [{ rel: "open", href: "/app/pulse/base" }],
        },
      ]).success,
    ).toBeTrue();
  });

  postgresTest("discovers and executes only data visible to the current access subject", async () => {
    const suffix = crypto.randomUUID();
    const baseId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const metricId = crypto.randomUUID();
    const seriesId = crypto.randomUUID();
    const savedQueryId = crypto.randomUUID();
    const baseShortId = newShortId();
    const sourceShortId = newShortId();
    const savedQueryShortId = newShortId();
    const resourceKey = `service:agent-${suffix}`;
    const [userRow] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`pulse-capability-${suffix}`}, 'local', 'user', 'Pulse capability test', ${`pulse-capability-${suffix}@example.test`})
      RETURNING id
    `;
    const [otherUserRow] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`pulse-capability-other-${suffix}`}, 'local', 'user', 'Pulse capability other', ${`pulse-capability-other-${suffix}@example.test`})
      RETURNING id
    `;
    if (!userRow || !otherUserRow) throw new Error("Failed to create Pulse capability users");
    const user = testUser(userRow.id, suffix);
    const context = userContext(user);
    const otherContext = userContext(testUser(otherUserRow.id, `other-${suffix}`));
    let accessId: string | null = null;

    try {
      await sql`INSERT INTO pulse.bases (id, short_id, name, description) VALUES (${baseId}::uuid, ${baseShortId}, 'Agent telemetry', 'Capability fixture')`;
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission) VALUES (${user.id}::uuid, 'admin') RETURNING id
      `;
      if (!access) throw new Error("Failed to create Pulse capability access");
      accessId = access.id;
      await sql`INSERT INTO pulse.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
      await sql`
        INSERT INTO pulse.sources (id, short_id, base_id, kind, name, last_seen_at)
        VALUES (${sourceId}::uuid, ${sourceShortId}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Agent source', now())
      `;
      await sql`
        INSERT INTO pulse.metric_defs (id, base_id, name, unit, type)
        VALUES (${metricId}::uuid, ${baseId}::uuid, 'agent.cpu', 'percent', 'gauge'::pulse.metric_type)
      `;
      await sql`
        INSERT INTO pulse.metric_series (
          id, base_id, metric_id, source_id, entity_id, entity_type, series_key, dimensions_hash, dimensions,
          resource_key, resource_id, resource_type, resource_label, last_seen_at
        ) VALUES (
          ${seriesId}::uuid, ${baseId}::uuid, ${metricId}::uuid, ${sourceId}::uuid, 'agent-1', 'service', ${suffix}, ${suffix},
          (${JSON.stringify({ env: "test" })}::jsonb #>> '{}')::jsonb,
          ${resourceKey}, 'agent-1', 'service', 'Agent service', now()
        )
      `;
      await sql`
        INSERT INTO pulse.metric_samples (base_id, series_id, ts, value)
        VALUES (${baseId}::uuid, ${seriesId}::uuid, now() - interval '1 minute', 42)
      `;
      await sql`
        INSERT INTO pulse.events (
          id, base_id, source_id, ts, kind, entity_id, entity_type, dimensions_hash, dimensions, attributes, payload
        )
        SELECT
          gen_random_uuid(), ${baseId}::uuid, ${sourceId}::uuid, now() - make_interval(secs => item), 'agent.event',
          'agent-1', 'service', item::text, '{}'::jsonb, '{"internal":"hidden"}'::jsonb, '{"raw":"hidden"}'::jsonb
        FROM generate_series(1, 101) AS item
      `;
      const largeDimensions = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`dimension_${index}`.padEnd(80, "k"), "v".repeat(500)]),
      );
      await sql`
        INSERT INTO pulse.events (
          id, base_id, source_id, ts, kind, entity_id, entity_type, dimensions_hash, dimensions, attributes, payload
        )
        SELECT
          gen_random_uuid(), ${baseId}::uuid, ${sourceId}::uuid, now() - make_interval(secs => item), 'agent.large',
          'agent-1', 'service', ${suffix} || '-large-' || item::text,
          (${JSON.stringify(largeDimensions)}::jsonb #>> '{}')::jsonb, '{}'::jsonb, '{}'::jsonb
        FROM generate_series(1, 20) AS item
      `;
      await sql`
        INSERT INTO pulse.events (
          id, base_id, source_id, ts, kind, entity_id, dimensions_hash, dimensions, attributes, payload, value
        ) VALUES (
          gen_random_uuid(), ${baseId}::uuid, ${sourceId}::uuid, now(), 'agent.nonfinite', 'agent-1', ${suffix} || '-nonfinite',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '+Infinity'::double precision
        )
      `;
      await sql`
        INSERT INTO pulse.signal_fields (base_id, source_id, scope, signal_name, role, key, value_type, observed_count, first_seen_at, last_seen_at)
        VALUES (${baseId}::uuid, ${sourceId}::uuid, 'metric', 'agent.cpu', 'dimension', 'env', 'string', 1, now(), now())
      `;
      const resourceRefId = crypto.randomUUID();
      await sql`
        INSERT INTO pulse.observed_resources (id, base_id, resource_key, resource_id, resource_type, label, source_ids, dimensions)
        VALUES (
          ${resourceRefId}::uuid, ${baseId}::uuid, ${resourceKey}, 'agent-1', 'service', 'Agent service', ARRAY[${sourceId}::uuid],
          (${JSON.stringify({ env: "test" })}::jsonb #>> '{}')::jsonb
        )
      `;
      const query = `metric agent.cpu avg every 1h since 1h source ${sourceShortId}`;
      await sql`
        INSERT INTO pulse.saved_queries (id, short_id, base_id, name, description, query, created_by)
        VALUES (${savedQueryId}::uuid, ${savedQueryShortId}, ${baseId}::uuid, 'Agent CPU', 'Capability fixture', ${query}, ${user.id}::uuid)
      `;

      const bases = await invoke("base.list", { query: "Agent", limit: 25 }, context);
      expect(bases.ok && bases.data.data).toEqual([
        expect.objectContaining({
          id: baseShortId,
          name: "Agent telemetry",
          links: [{ rel: "open", href: `/app/pulse/${baseShortId}` }],
        }),
      ]);
      const hiddenBases = await invoke("base.list", { limit: 25 }, otherContext);
      expect(hiddenBases.ok && hiddenBases.data.data).toEqual([]);
      const baseRead = await invoke("base.read", { id: baseShortId }, context);
      expect(baseRead.ok && baseRead.data).toMatchObject({
        data: { id: baseShortId },
        summary: "Read Pulse Base “Agent telemetry”.",
        refs: [{ type: "pulse.base", id: baseShortId }],
      });

      const sources = await invoke("source.list", { baseId: baseShortId, limit: 25 }, context);
      expect(sources.ok && sources.data.data).toEqual([
        expect.objectContaining({
          id: sourceShortId,
          name: "Agent source",
          links: [{ rel: "open", href: `/app/pulse/${baseShortId}/sources/${sourceShortId}` }],
        }),
      ]);
      const sourceRead = await invoke("source.read", { id: sourceShortId }, context);
      expect(sourceRead.ok && sourceRead.data).toMatchObject({
        data: { id: sourceShortId, baseId: baseShortId },
        summary: "Read Pulse Source “Agent source”.",
        refs: [{ type: "pulse.source", id: sourceShortId }],
      });
      const resources = await invoke("resource.search", { query: "Agent service", tags: [], limit: 10 }, context);
      expect(resources.ok && resources.data.data).toEqual([
        expect.objectContaining({
          ref: { type: "pulse.resource", id: `${baseShortId}/${resourceKey}` },
          title: "Agent service",
          metadata: expect.arrayContaining([{ label: "Base ID", value: baseShortId }]),
        }),
      ]);
      const resourceRead = await invoke("resource.read", { id: `${baseShortId}/${resourceKey}` }, context);
      expect(resourceRead.ok && resourceRead.data).toMatchObject({
        data: { id: `${baseShortId}/${resourceKey}`, baseId: baseShortId, key: resourceKey },
        summary: "Read Pulse Resource “Agent service”.",
        refs: [{ type: "pulse.resource", id: `${baseShortId}/${resourceKey}` }],
      });
      const metrics = await invoke("metric.search", { baseId: baseShortId, query: "agent", limit: 25 }, context);
      expect(metrics.ok && metrics.data.data).toEqual([
        expect.objectContaining({
          name: "agent.cpu",
          seriesCount: 1,
          links: [{ rel: "open", href: `/app/pulse/${baseShortId}/metrics/agent.cpu` }],
        }),
      ]);
      const fields = await invoke("field.search", { baseId: baseShortId, query: "env", role: "dimension", limit: 25 }, context);
      expect(fields.ok && fields.data.data).toEqual([
        expect.objectContaining({
          signalName: "agent.cpu",
          key: "env",
          links: [{ rel: "open", href: `/app/pulse/${baseShortId}/metrics/agent.cpu` }],
        }),
      ]);

      const compiled = await invoke("query.compile", { baseId: baseShortId, query }, context);
      expect(compiled.ok && compiled.data.data).toMatchObject({ valid: true, kind: "metric" });
      if (compiled.ok) expect(compiled.data.summary).toBe("Validated a metric Pulse query.");
      const executed = await invoke("query.execute", { baseId: baseShortId, query }, context);
      expect(executed.ok && executed.data.data).toMatchObject({ kind: "metric", points: [expect.objectContaining({ value: 42 })] });
      if (executed.ok) expect(executed.data.summary).toBe("Executed metric Pulse query with 1 point.");
      const tooBroad = await invoke("query.execute", { baseId: baseShortId, query: "metric agent.cpu avg every 1m since 1d" }, context);
      expect(tooBroad.ok).toBe(false);
      if (!tooBroad.ok) expect(tooBroad.error.message).toContain("too many grouped points");
      const events = await invoke("query.execute", { baseId: baseShortId, query: "events agent.event since 1h limit 1000" }, context);
      expect(events.ok && events.data.data.events).toHaveLength(100);
      if (events.ok) {
        expect(events.data.data.limitApplied).toBe(100);
        expect(events.data.data.truncated).toBe(true);
        expect(events.data.data.events[0]?.sourceId).toBe(sourceShortId);
        expect(events.data.data.events[0]).not.toHaveProperty("payload");
        expect(events.data.data.events[0]).not.toHaveProperty("attributes");
      }
      const largeEvents = await invoke("query.execute", { baseId: baseShortId, query: "events agent.large since 1h limit 100" }, context);
      expect(largeEvents.ok).toBe(true);
      if (largeEvents.ok) {
        expect(largeEvents.data.data.events.length).toBeGreaterThan(0);
        expect(largeEvents.data.data.events.length).toBeLessThan(20);
        expect(largeEvents.data.data.truncated).toBe(true);
        expect(new TextEncoder().encode(JSON.stringify(largeEvents.data)).byteLength).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
      }
      const nonfinite = await invoke("query.execute", { baseId: baseShortId, query: "events agent.nonfinite since 1h limit 10" }, context);
      expect(nonfinite.ok && nonfinite.data.data.events[0]?.value).toBeNull();
      const saved = await invoke("saved_query.list", { baseId: baseShortId, limit: 25 }, context);
      expect(saved.ok && saved.data.data).toEqual([expect.objectContaining({ id: savedQueryShortId, query })]);
      const savedRead = await invoke("saved_query.read", { id: savedQueryShortId }, context);
      expect(savedRead.ok && savedRead.data).toMatchObject({
        data: { id: savedQueryShortId, baseId: baseShortId },
        summary: "Read saved Pulse Query “Agent CPU”.",
        refs: [{ type: "pulse.saved_query", id: savedQueryShortId }],
      });
      const savedExecution = await invoke("saved_query.execute", { baseId: baseShortId, queryId: savedQueryShortId }, context);
      expect(savedExecution.ok && savedExecution.data.data).toMatchObject({
        kind: "metric",
        points: [expect.objectContaining({ value: 42 })],
      });
      if (savedExecution.ok) expect(savedExecution.data.summary).toBe("Executed saved Pulse Query “Agent CPU” with 1 point.");
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${user.id}::uuid, ${otherUserRow.id}::uuid)`;
    }
  });
});
