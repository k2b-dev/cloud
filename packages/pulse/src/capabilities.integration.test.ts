import { afterAll, beforeAll, expect, setDefaultTimeout } from "bun:test";
import { assertResourceOpenLink } from "@k2b/cloud/capabilities/testing";
import { type CapabilityExecutionContext, type CapabilityQueryDefinition, capabilityResultSchema, type User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";
import { pulseCapabilities } from "./capabilities";
import { newShortId } from "./lib/short-id";
import { seedActiveBaseStore } from "./service/base-store.test-fixture";
import { settingsFixture } from "./store/settings.test-fixture";

let settings: ReturnType<typeof settingsFixture>;
beforeAll(() => {
  settings = settingsFixture();
  settings.values["pulse.clickhouse_connection"] = JSON.stringify({
    url: "http://127.0.0.1:1",
    user: "fixture",
    password: "fixture-password",
  });
});
afterAll(() => settings.restore());
const userContext = (user: User): CapabilityExecutionContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "req-test",
  origin: "app",
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

setDefaultTimeout(60_000);
const postgresTest = testFor("database");

postgresTest("lets agent service accounts read only the bases they were granted, within their scopes", async () => {
  const grantedBaseId = crypto.randomUUID();
  const otherBaseId = crypto.randomUUID();
  const grantedBaseShortId = newShortId();
  const otherBaseShortId = newShortId();
  const [agent] = await sql<{ id: string; createdAt: string }[]>`
      INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Pulse capability agent test', 'agent')
      RETURNING id::text AS id, created_at::text AS "createdAt"
    `;
  if (!agent) throw new Error("Failed to create agent Pulse fixture");
  const agentContext = (scopes: string[]): CapabilityExecutionContext => ({
    actor: {
      kind: "service_account",
      serviceAccount: {
        id: agent.id,
        name: "Pulse capability agent test",
        kind: "agent",
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: null,
        createdAt: agent.createdAt,
      },
      delegatedUser: null,
      scopes,
    },
    accessSubject: { type: "service_account", serviceAccountId: agent.id },
    user: null,
    locale: "en",
    requestId: "req-test",
    origin: "app",
    signal: new AbortController().signal,
  });
  let accessId: string | null = null;

  try {
    await sql`
        INSERT INTO pulse.bases (id, short_id, name) VALUES
          (${grantedBaseId}::uuid, ${grantedBaseShortId}, 'Granted agent telemetry'),
          (${otherBaseId}::uuid, ${otherBaseShortId}, 'Other agent telemetry')
      `;
    await seedActiveBaseStore(grantedBaseId, otherBaseId);
    const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission)
        VALUES (${agent.id}::uuid, 'write'::auth.permission_level)
        RETURNING id::text AS id
      `;
    accessId = access!.id;
    await sql`INSERT INTO pulse.base_access (base_id, access_id) VALUES (${grantedBaseId}::uuid, ${accessId}::uuid)`;

    // A `read` token reaches the base behind the agent's `write` grant and nothing else.
    const context = agentContext(["read"]);
    const listed = await invoke("base.list", { limit: 25 }, context);
    expect(listed.ok && listed.data.data).toEqual([expect.objectContaining({ id: grantedBaseShortId })]);
    const read = await invoke("base.read", { id: grantedBaseShortId }, context);
    expect(read.ok && read.data.data).toMatchObject({ id: grantedBaseShortId });
    const ungranted = await invoke("base.read", { id: otherBaseShortId }, context);
    expect(ungranted).toMatchObject({ ok: false, error: { status: 403 } });

    // A token without `read` reaches nothing, even with the grant.
    const unscoped = agentContext(["openid"]);
    const hidden = await invoke("base.list", { limit: 25 }, unscoped);
    expect(hidden.ok && hidden.data.data).toEqual([]);
    const denied = await invoke("base.read", { id: grantedBaseShortId }, unscoped);
    expect(denied).toMatchObject({ ok: false, error: { status: 403 } });
  } finally {
    await sql`DELETE FROM pulse.bases WHERE id IN (${grantedBaseId}::uuid, ${otherBaseId}::uuid)`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${agent.id}::uuid`;
  }
});

postgresTest("reads only bases and sources visible to the current access subject", async () => {
  const suffix = crypto.randomUUID();
  const baseId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const baseShortId = newShortId();
  const sourceShortId = newShortId();
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
    await seedActiveBaseStore(baseId);
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
    for (const [typeId, id] of [
      ["base", baseShortId],
      ["source", sourceShortId],
    ] as const) {
      const result = await invoke(`${typeId}.read`, { id }, context);
      if (!result.ok) throw new Error(result.error.message);
      assertResourceOpenLink(result.data);
    }
  } finally {
    await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id IN (${user.id}::uuid, ${otherUserRow.id}::uuid)`;
  }
});
