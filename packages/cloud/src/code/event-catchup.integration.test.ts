import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { z } from "zod";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import type { CodeContext } from "../../../core/src/code/access";
import { readCodeEventCatchup, startCodeEventCatchup, startCodeEventCatchupRuntime } from "../../../core/src/code/event-catchup";
import { syncCodeEventSubscriptions } from "../../../core/src/code/event-subscriptions";
import { CODE_SETTINGS, codeSettings } from "../../../core/src/code/settings";
import { codeBundleHash, codeSourceHash, findCode } from "../../../core/src/code/store";
import { migrate as migrateAppApproval } from "../../../core/src/migrate/core/app-approval";
import { migrate as migrateAppEvents } from "../../../core/src/migrate/core/app-events";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateCode } from "../../../core/src/migrate/core/code";
import { migrate as migrateActivation } from "../../../core/src/migrate/core/code-activation";
import { migrate as migrateLifecycle } from "../../../core/src/migrate/core/code-lifecycle";
import { migrate as migratePolicy } from "../../../core/src/migrate/core/code-policy";
import { migrate as migrateScheduling } from "../../../core/src/migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../../../core/src/migrate/core/code-versions";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateLogging } from "../../../core/src/migrate/core/logging";
import { migrate as migrateRailPreferences } from "../../../core/src/migrate/core/rail-preferences";
import { migrate as migrateRailShortcuts } from "../../../core/src/migrate/core/rail-shortcuts";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { migrate as migrateWorkflows } from "../../../core/src/migrate/core/workflows";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { migrate as migrateMail } from "../../../mail/src/migrate";
import { compileCapabilities, invokeCompiledCapability } from "../_internal/capabilities";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import * as registry from "../_internal/registry";
import * as catalogProvider from "../capabilities/server";
import * as serverInvoke from "../capabilities/server-invoke";
import { CodeCheckedVersionManifestSchema } from "../contracts";
import { AppEventEnvelopeSchema } from "../contracts/app-events";
import { installLiveOutbox } from "../events/testing";
import { bindProcessSync, sql, unbindProcessSync } from "../index";
import { accounts } from "../services";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1),
  principal = id(2),
  codeId = "c_catchupmail";
suiteFor("database", "nats")("historical Mail Code admission", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: ReturnType<typeof createSync>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let editor: CodeContext;
  let versionId: string,
    number = 0;
  const runs = () => sql`SELECT * FROM code.runs WHERE code_id=${codeId}`;
  const waitUntil = async (condition: () => Promise<boolean>) => {
    const deadline = performance.now() + 15_000;
    while (!(await condition())) {
      if (performance.now() >= deadline) throw new Error("Catch-up did not reach the expected state within the test deadline");
      await Bun.sleep(30);
    }
  };
  beforeAll(async () => {
    database = await useFreshDatabase("code_historical_mail");
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("code-historical-mail"), application: "core", defaults: { replicas: 1 } });
    await sync.ready();
    bindProcessSync(sync, connection);
    for (const migrate of [
      migrateAuth,
      migrateRailPreferences,
      migrateRailShortcuts,
      migrateAppApproval,
      migrateAudit,
      migrateSettings,
      migrateEvents,
      migrateAppEvents,
      migrateCode,
      migratePolicy,
      migrateVersions,
      migrateActivation,
      migrateScheduling,
      migrateLifecycle,
    ])
      await migrate();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'catchup-owner','local','user')`;
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Missing editor");
    editor = {
      authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner }, credentialKind: "session", scopes: [] },
    };
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) => CODE_SETTINGS[key].default);
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
  });
  afterAll(async () => {
    settings?.mockRestore();
    unbindProcessSync();
    await sync?.drain({ timeoutMs: 1000 });
    await connection?.drain();
    setSystemTime();
    await sql.close();
    await database?.drop();
  });
  async function activate() {
    await sql.begin(async (db) => {
      await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      const code = await findCode(codeId, db);
      if (!code) throw new Error("Missing Code fixture");
      await syncCodeEventSubscriptions(code, versionId, db);
      await db`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    });
  }
  async function version(eventType: string, eventPlace: { type: string; id: string }, ai = false) {
    number++;
    const files = { "code.ts": `fixture ${number}` },
      bundle = "export default {};";
    const manifest = CodeCheckedVersionManifestSchema.parse({
      version: 1,
      entry: "code.ts",
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: [
        {
          kind: "event",
          entrypoint: `event:${eventType}@1`,
          cron: null,
          file: "code.ts",
          line: 1,
          event: { type: eventType, version: 1, place: eventPlace },
        },
      ],
      permissions: [],
      ai,
      policyRows: ai ? ["ai", "read"] : ["read"],
    });
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},${number},${JSON.stringify(files)}::text::jsonb,${bundle},${manifest.hashes.source},${manifest.hashes.bundle},${JSON.stringify(manifest)}::text::jsonb,16,18,${owner}::uuid) RETURNING id`;
    versionId = row!.id;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding) VALUES(${versionId}::uuid,${codeId},'{}'::jsonb)`;
    await sql`INSERT INTO auth.mandates(subject_kind,subject_service_account_id,owner_app_id,workload_type,workload_id,policy)
      VALUES('service_account',${principal}::uuid,'runner','code.version',${versionId},'{"version":1,"apps":[],"operations":[],"actions":"deny"}'::jsonb) RETURNING id`;
  }
  async function createOwnedCode(ownerPlace: { type: string; id: string }) {
    await sql`INSERT INTO auth.service_accounts(id,name,kind,created_by) VALUES(${principal}::uuid,${`code:${ownerPlace.type}:${ownerPlace.id}`},'code',${owner}::uuid)`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,service_account_id,title,state,created_by)
      VALUES(${codeId},'resource',${ownerPlace.type},${ownerPlace.id},${principal}::uuid,'Events','draft',${owner}::uuid)`;
    await sql`INSERT INTO auth.access(id,user_id,permission) VALUES(${id(3)}::uuid,${owner}::uuid,'write')`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${codeId},${id(3)}::uuid)`;
  }
  test("historical Mail resolves its own receipt and checks current readers without live delivery rows", async () => {
    await installLiveOutbox(sql);
    await migrateLogging();
    await migrateWorkflows();
    await migrateMail();
    const mailbox = { type: "mail.mailbox", id: "Box456" };
    await createOwnedCode(mailbox);
    await version("mail.message.received", mailbox);
    await activate();
    const [box] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes(short_id,name) VALUES(${mailbox.id},'Historical') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${box!.id}::uuid,${id(3)}::uuid)`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${principal}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${box!.id}::uuid,${grant!.id}::uuid)`;
    const [remote] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources(mailbox_id,remote_locator,server_identity,scope_fingerprint)
      VALUES(${box!.id}::uuid,'{}','{}',${"a".repeat(64)}) RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders(short_id,remote_resource_id,stable_key,name,role)
      VALUES('Fld456',${remote!.id}::uuid,'inbox','Inbox','inbox') RETURNING id`;
    for (const [index, shortId] of ["Msg456", "Msg457"].entries()) {
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents(short_id,mailbox_id,internal_date,hydration_status)
        VALUES(${shortId},${box!.id}::uuid,'2026-11-01T12:00:00Z','complete') RETURNING id`;
      const [receipt] = await sql<
        { id: string }[]
      >`INSERT INTO mail.remote_message_refs(folder_id,message_id,uid_validity,uid,first_seen_at)
        VALUES(${folder!.id}::uuid,${message!.id}::uuid,1,${index + 1},'2026-11-01T12:00:00Z') RETURNING id`;
      await sql`INSERT INTO mail.message_placements(remote_message_ref_id,folder_id,message_id)
        VALUES(${receipt!.id}::uuid,${folder!.id}::uuid,${message!.id}::uuid)`;
    }
    const compiled = compileCapabilities("mail", mailCapabilities);
    const entry = {
      appId: "mail",
      appName: "Mail",
      appDescription: "Mail",
      appIcon: "mail",
      endpoint: "http://mail.test",
      manifest: compiled.manifest,
    };
    const catalog = spyOn(catalogProvider, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: entry });
    const lookup = spyOn(registry, "getCapability").mockResolvedValue(entry);
    const originalCredential = process.env.CLOUD_APP_CREDENTIAL;
    const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    process.env.CLOUD_APP_CREDENTIAL = "fixture-core-workload";
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
    bindProcessApplicationId("core", ["resources:readers"]);
    // Substitute only transport: execute the actual Mail resolver and generated reader against SQL.
    const transport = spyOn(serverInvoke, "invokeCapabilityWithDataSchema").mockImplementation(async (call, schema) => {
      const operation = compiled.queries.get(call.capabilityId)!;
      const appOnly = operation.manifest.appOnly === true;
      const common = { locale: "en", requestId: "historical-fixture", origin: "app" as const, signal: new AbortController().signal };
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: call.capabilityId,
        input: call.input,
        expectedSchemaHash: operation.manifest.schemaHash,
        context: appOnly
          ? { ...common, actor: { kind: "app", appId: "core" }, accessSubject: { type: "none" }, user: null }
          : {
              ...common,
              ...editor.authority,
              authority: editor.authority,
              user: editor.authority.actor.kind === "user" ? editor.authority.actor.user : null,
            },
      });
      return result.ok ? { ok: true, data: { ...result.data, data: schema.parse(result.data.data) } } : result;
    });
    let stop: (() => Promise<void>) | undefined;
    try {
      const resolve = async (subject: string) => {
        const result = await mailCapabilities.queries["message.event"].run(
          { id: subject },
          {
            ...editor.authority,
            authority: editor.authority,
            user: editor.authority.actor.kind === "user" ? editor.authority.actor.user : null,
            locale: "en",
            requestId: "canonical-fixture",
            origin: "app",
            signal: new AbortController().signal,
          },
        );
        if (!result.ok) throw new Error(result.error.message);
        return AppEventEnvelopeSchema.parse(result.data.data);
      };
      const first = await resolve("Msg456");
      expect(first.id).toBe(z.object({ receiptId: z.uuid() }).parse(first.data).receiptId);
      await startCodeEventCatchup(codeId, { operationId: id(70), versionId, events: [first] }, editor);
      stop = await startCodeEventCatchupRuntime();
      await waitUntil(async () => (await readCodeEventCatchup(codeId, id(70), editor)).status === "completed");
      expect(await readCodeEventCatchup(codeId, id(70), editor)).toMatchObject({ status: "completed", dispatched: 1 });
      expect(await runs()).toHaveLength(1);
      await startCodeEventCatchup(codeId, { operationId: id(71), versionId, events: [first] }, editor);
      await waitUntil(async () => (await readCodeEventCatchup(codeId, id(71), editor)).status === "completed");
      expect(await readCodeEventCatchup(codeId, id(71), editor)).toMatchObject({ status: "completed", dispatched: 1 });
      expect(await runs()).toHaveLength(1);
      await stop();
      stop = undefined;
      const second = await resolve("Msg457");
      await startCodeEventCatchup(codeId, { operationId: id(72), versionId, events: [second] }, editor);
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      stop = await startCodeEventCatchupRuntime();
      await waitUntil(async () => (await readCodeEventCatchup(codeId, id(72), editor)).failureCount > 0);
      expect(await readCodeEventCatchup(codeId, id(72), editor)).toMatchObject({
        dispatched: 0,
        lastError: "The handler's resource access is unavailable.",
      });
      expect((await readCodeEventCatchup(codeId, id(72), editor)).failureCount).toBeGreaterThan(0);
      expect(await runs()).toHaveLength(1);
      expect(await sql`SELECT * FROM events.app_events`).toHaveLength(0);
      expect(await sql`SELECT * FROM events.app_deliveries`).toHaveLength(0);
    } finally {
      await stop?.();
      transport.mockRestore();
      lookup.mockRestore();
      catalog.mockRestore();
      clearProcessApplicationId();
      if (originalCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
      else process.env.CLOUD_APP_CREDENTIAL = originalCredential;
      if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
    }
  }, 20000);
});
