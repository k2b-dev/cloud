import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import { sql } from "@k2b/cloud";
import * as catalog from "@k2b/cloud/capabilities/server";
import { signCodeRunToken } from "@k2b/cloud/code/run-token";
import {
  type CloudRuntime,
  type CodeCheckedVersionManifest,
  capabilityResultSchema,
  NormalizedCapabilityCallSchema,
  type User,
} from "@k2b/cloud/contracts";
import { type AuthContext, userFromActor } from "@k2b/cloud/server";
import { accounts, session } from "@k2b/cloud/services";
import { appKeys } from "@k2b/cloud/services/app-keys";
import { useTestSettings } from "@k2b/cloud/services/settings/settings.test-fixture";
import { createSync, type Sync, type Worker } from "@k2b/sync";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import {
  type AcceptanceProvider,
  AcceptanceProviderSchema,
  acceptanceProvider,
  loadCodePage,
} from "../../../../scripts/fixtures/code-acceptance-provider";
import { codeOwnerProofs, signCodeOwnerRead } from "../../../../scripts/fixtures/code-platform";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "../../../mail/src/service/auth";
import { aiCapabilities } from "../capabilities";
import { acceptanceChecker, acceptanceDispatch, acceptanceRunners } from "./acceptance.test-fixture";
import { type CodeContext, codeAccountDisplayName } from "./access";
import { activateCodeVersion, processCodeActivation, readCodeActivation } from "./activation";
import { cleanupCodeActivation } from "./activation-maintenance";
import { codeAuthoringServices as code } from "./authoring";
import { codeDeletionOutbox, codeOwnerDeletedOutbox } from "./lifecycle";
import * as ownerTransport from "./owner-transport";
import * as runnerHosts from "./runner-jobs";

import { type CodeRunWakeup, createCodeRunOutbox, createCodeScheduleReconciler } from "./scheduling-runtime";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { addCodeShare, findCode, readCodeRun } from "./store";
import type { CodeVersionSubmission } from "./version-contracts";
import { decideCodeVersion, startCodeVersionApprovals } from "./versions";

// Select an isolated clone containing the real Core, Mail and Spaces migrations before domain setup.
await import("../../../mail/test/integration-preload");
const { mailCapabilities } = await import("../../../mail/src/capabilities");
const { createMailbox, deleteMailbox } = await import("../../../mail/src/service/mailboxes");
const { createSenderIdentity } = await import("../../../mail/src/service/sender-identities");

// The conceptual sp_4kd2 is represented by a valid six-character public Space ID.
const spaceId = "Sp4kd2",
  foreignId = "Sp0bad",
  columnId = "Col025",
  itemId = "Itm025";
const space = { type: "spaces.space", id: spaceId };
const issuer = "https://cloud.example";
const secretValue = "fictional-c25-private-credential";
const context = (user: User): CodeContext & MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
  locale: "de",
});
const source = (body: string) => ({
  "code.ts": `import { app, spaces, mail, http, secrets } from "@sdk";
app.schedule({ cron: "0 8 * * 1", name: "monday" }, async () => {
${body}
});
export default app;`,
});
const creation = source(
  `await spaces.space("${spaceId}").task.create({ columnId: "${columnId}", title: "Rechnung 2026-025 prüfen", idempotencyKey: "invoice:2026-025" });`,
);
const update = source(
  `await spaces.space("${spaceId}").task.update({ itemId: "${itemId}", title: "Rechnung geprüft", expectedTitle: "Vorhandene Rechnung" });`,
);

suiteFor(
  "database",
  "nats",
  "valkey",
)("C25 mailbox schedule acceptance with two stateless runners", () => {
  useTestSettings({
    "app.url": issuer,
    "app.timezone": "UTC",
    "security.rate_limit_per_second": 60,
  });
  let lea: User, ben: User, reviewer: User;
  let author: ReturnType<typeof context>, manager: ReturnType<typeof context>;
  let mailboxId: string, mailboxRef: { type: string; id: string }, senderId: string;
  let internalSpaceId: string, foreignSpaceId: string;
  let checker: Awaited<ReturnType<typeof acceptanceChecker>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>, sync: Sync;
  let fleet: Awaited<ReturnType<typeof acceptanceRunners>>;
  let runOutbox: ReturnType<typeof createCodeRunOutbox>;
  let worker: Worker | undefined;
  let providers: Map<string, AcceptanceProvider>;
  let spaces: AcceptanceProvider & Required<Pick<AcceptanceProvider, "permission" | "accessList" | "grant" | "revoke">>;
  const restores: Array<() => void> = [];
  const messages: unknown[] = [];
  const sentHttp: string[] = [];
  async function person(name: string, admin = false) {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,admin)
      VALUES(${`c25-${name}`},'local','user',${name},${admin}) RETURNING id`;
    const user = await accounts.users.get({ id: row!.id });
    if (!user) throw new Error("Missing acceptance person");
    return user;
  }
  beforeAll(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    lea = await person("Lea");
    ben = await person("Ben");
    reviewer = await person("Ari", true);
    restores.push(startCodeVersionApprovals());
    author = context(lea);
    manager = context(ben);
    for (const log of [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")]) {
      log.mockImplementation((...args) => {
        messages.push(args);
      });
      restores.push(() => log.mockRestore());
    }
    const settings = spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === "core.code.runner_slots"
        ? 1
        : key === "core.code.runner_poll_ms"
          ? 1000
          : // The full frozen-clock suite budget (30s + 120s + 60s) fits below the token's remaining 240s margin.
            key === "core.code.wall_clock_ms"
            ? 60_000
            : CODE_SETTINGS[key].default,
    );
    restores.push(() => settings.mockRestore());
    // Ben manages both resources; Lea has an explicit Code editor share and ordinary mailbox write access.
    const mailbox = await createMailbox(manager, { name: "rechnung@beispiel.test" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mail] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id=${mailboxId}::uuid`;
    mailboxRef = { type: "mail.mailbox", id: mail!.short_id };
    const [mailShare] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${lea.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${mailboxId}::uuid,${mailShare!.id}::uuid)`;
    const identity = await createSenderIdentity({
      context: manager,
      mailboxId,
      input: { label: "Rechnung", fromAddress: "rechnung@beispiel.test" },
    });
    if (!identity.ok) throw new Error(identity.error.message);
    await sql`UPDATE mail.sender_identities SET status='verified' WHERE id=${identity.data.id}::uuid`;
    const [sender] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.sender_identities WHERE id=${identity.data.id}::uuid`;
    senderId = sender!.short_id;
    for (const id of [spaceId, foreignId]) {
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO spaces.spaces(name,short_id) VALUES(${id === spaceId ? "Buchhaltung" : "Fremder Space"},${id}) RETURNING id`;
      if (id === spaceId) internalSpaceId = row!.id;
      else foreignSpaceId = row!.id;
      const [share] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${ben.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO spaces.space_access(space_id,access_id) VALUES(${row!.id}::uuid,${share!.id}::uuid)`;
    }
    const [audience] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(authenticated_only,permission) VALUES(TRUE,'write') RETURNING id`;
    await sql`INSERT INTO spaces.space_access(space_id,access_id) VALUES(${foreignSpaceId}::uuid,${audience!.id}::uuid)`;
    const [column] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.columns(space_id,name,short_id) VALUES(${internalSpaceId}::uuid,'Offen',${columnId}) RETURNING id`;
    await sql`INSERT INTO spaces.items(space_id,column_id,title,short_id,created_by)
      VALUES(${internalSpaceId}::uuid,${column!.id}::uuid,'Vorhandene Rechnung',${itemId},${ben.id}::uuid)`;

    const spacesModule: unknown = await import(new URL("../../../spaces/src/code-acceptance.test-fixture.ts", import.meta.url).href);
    spaces = z
      .object({
        provider: AcceptanceProviderSchema.extend({
          grant: AcceptanceProviderSchema.shape.grant.unwrap(),
          revoke: AcceptanceProviderSchema.shape.revoke.unwrap(),
          permission: AcceptanceProviderSchema.shape.permission.unwrap(),
          accessList: AcceptanceProviderSchema.shape.accessList.unwrap(),
        }),
      })
      .parse(spacesModule).provider;
    providers = new Map([
      ["spaces", spaces],
      ["mail", AcceptanceProviderSchema.parse(acceptanceProvider("mail", mailCapabilities))],
    ]);
    const app = (appId: string) => ({
      appId,
      appName: appId,
      appIcon: "ti ti-code",
      appDescription: "Acceptance provider",
      manifest: providers.get(appId)!.manifest,
    });
    const listing = spyOn(catalog, "listCapabilityCatalog").mockResolvedValue({
      ok: true,
      data: { protocolVersion: 2, apps: [...providers.keys()].map(app), page: { hasMore: false } },
    });
    const single = spyOn(catalog, "getCapabilityCatalogApp").mockImplementation(async (id) => ({
      ok: true,
      data: providers.has(id) ? app(id) : null,
    }));
    const coreProvider = acceptanceProvider("core", aiCapabilities);
    const reader = spyOn(catalog, "invokeCapabilityWithDataSchema").mockImplementation(async (input, schema, caller) => {
      const authority = caller.authority ?? (caller.cookie === "session_token=c25-page-lea" ? author.authority : null);
      if (!authority) throw new Error("Reader needs authority");
      const provider = input.appId === "core" ? coreProvider : providers.get(input.appId)!;
      const response = await provider.invoke({
        kind: "query",
        localId: input.capabilityId,
        input: input.input,
        expectedSchemaHash: provider.manifest.queries.find((op) => op.localId === input.capabilityId)!.schemaHash,
        context: {
          authority,
          actor: authority.actor,
          accessSubject: authority.accessSubject,
          user: userFromActor(authority.actor),
          origin: "app",
          locale: "de",
          requestId: "c25-reader",
          signal: new AbortController().signal,
        },
      });
      if (!response.ok)
        return { ok: false as const, error: { code: "FORBIDDEN", message: "Acceptance resource reader denied", status: response.status } };
      const result = capabilityResultSchema(schema).parse(await response.json());
      return { ok: true as const, data: result };
    });
    restores.push(
      () => listing.mockRestore(),
      () => single.mockRestore(),
      () => reader.mockRestore(),
    );
    const registry = spyOn(cloud, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-code",
      description: "Acceptance",
      baseUrl: `http://${id}.test`,
      routes: [],
      access: { kind: "signedIn" },
    }));
    restores.push(() => registry.mockRestore());
    const pair = await generateKeyPair("RS256", { extractable: true });
    const kid = "25252525-2525-4525-8525-252525252525";
    const signer = { kid, key: pair.privateKey, signUntil: new Date(clock!.now.getTime() + 3_600_000) };
    const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
    const verifyInspection = codeOwnerProofs.verifyCodeOwnerRead;
    const inspectionKeys = spyOn(codeOwnerProofs, "verifyCodeOwnerRead").mockImplementation((token, appId) =>
      verifyInspection(token, appId, { issuer, key }),
    );
    restores.push(() => inspectionKeys.mockRestore());
    // The shared authoring service still invokes the real isolated checker. This fixture only replaces its network hop.
    checker = await acceptanceChecker();
    const checkHost = spyOn(runnerHosts, "createRunnerCodeCheckHost").mockReturnValue({ check: checker.check });
    restores.push(() => checkHost.mockRestore());
    const ownerTitle = spyOn(ownerTransport, "readCodeResourceOwnerTitle").mockImplementation(async (ref, principal) => {
      const appId = ref.type.split(".")[0]!;
      const token = await signCodeOwnerRead(appId, principal, { issuer, signer });
      const response = await providers.get(appId)!.authority(
        new Request(`http://${appId}.test/queries/code.owner.title`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(ref),
        }),
      );
      if (!response.ok) throw new Error("Owner title transport failed");
      return z.object({ data: z.object({ title: z.string().nullable() }) }).parse(await response.json()).data.title;
    });
    restores.push(() => ownerTitle.mockRestore());
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("c25"), application: "core", defaults: { replicas: 1 } });
    const queue = sync.queue<CodeRunWakeup>({ id: "runs", dedupeWindowMs: 60_000, retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 } });
    await sync.ready();
    runOutbox = createCodeRunOutbox(() => queue);
    const keyFixture = APP_KEY_FIXTURES[0]!;
    const enrolled = await appKeys.register({
      actor: { id: reviewer.id, uid: reviewer.uid, provider: "local", roles: reviewer.roles },
      appId: "runner",
      publicKey: keyFixture.publicKey,
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    fleet = await acceptanceRunners({
      queue,
      issuer,
      key,
      httpSend: async (input) => {
        expect(input.headers.authorization).toBe("Bearer " + secretValue);
        sentHttp.push(String(input.url));
        if (String(input.url).endsWith("/error")) throw new Error(secretValue);
        return { status: 200, headers: { etag: secretValue }, body: Buffer.from(JSON.stringify({ echo: secretValue })) };
      },
      runnerKey: { appId: "runner", seed: keyFixture.seed, installationId: enrolled.data.installationId, keyId: enrolled.data.keyId },
      sign: (claims, options) => signCodeRunToken(claims, { ...options, issuer, signer }),
      dispatch: {
        ...acceptanceDispatch(providers, issuer, signer, key),
        getCapability: async (id) =>
          providers.has(id) ? { ...app(id), endpoint: `http://${id}.test/api/_internal/capabilities/v1` } : null,
      },
    });
  }, 30_000);
  afterAll(async () => {
    worker?.stop();
    await worker?.drain({ timeoutMs: 1000 });
    await fleet?.close();
    await runOutbox?.stop();
    await sync?.drain({ timeoutMs: 1000 });
    await connection?.drain();
    await checker?.close();
    for (const restore of restores.reverse()) restore();
    setSystemTime();
  });
  async function approve(submission: CodeVersionSubmission) {
    if (submission.status === "pending") await decideCodeVersion(submission.binding, true, context(reviewer));
  }
  const proof = (ctx: ReturnType<typeof context>) => ({
    ...ctx,
    authority: {
      ...ctx.authority,
      credentialProof: {
        kind: "session" as const,
        userId: ctx.authority.accessSubject.type === "user" ? ctx.authority.accessSubject.userId : "",
        sid: crypto.randomUUID(),
        authEpoch: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  });
  async function activate(codeId: string, versionId: string, ctx = manager) {
    const receipt = await activateCodeVersion({ codeId, versionId, activationId: crypto.randomUUID() }, ctx);
    await processCodeActivation(receipt.id, {
      restoreAuthority: async () => ctx,
    });
    expect(await readCodeActivation({ codeId, activationId: receipt.id }, ctx)).toMatchObject({ state: "active", failure: null });
  }
  async function completed(codeId: string, runId: string, ctx = author) {
    const signal = AbortSignal.timeout(10_000);
    while (!signal.aborted) {
      await runOutbox.reconcile();
      const run = await readCodeRun({ codeId, runId, cursor: 0, offset: 0, length: 32768 }, ctx);
      if (["succeeded", "failed", "cancelled", "skipped"].includes(run.run.state)) {
        const calls = [...(run.contents?.calls ?? [])];
        let cursor = run.contents?.nextCursor;
        while (cursor !== null && cursor !== undefined) {
          signal.throwIfAborted();
          const page = await readCodeRun({ codeId, runId, cursor }, ctx);
          calls.push(...(page.contents?.calls ?? []));
          cursor = page.contents?.nextCursor;
        }
        return { ...run, calls };
      }
      await Bun.sleep(10);
    }
    throw new Error("Acceptance run did not reach a visible terminal state");
  }
  test("Lea checks, Ben activates, both runners execute, the manager revokes and Mail deletion cleans up", async () => {
    const initialized = await code.init({ title: "Rechnungen", owner: { kind: "resource", ref: mailboxRef } }, manager);
    const codeId = initialized.config.codeId;
    await addCodeShare(codeId, { type: "user", userId: lea.id }, "editor", manager);
    const personal = await code.init({ title: "Mein Montagsentwurf" }, author);
    const personalId = personal.config.codeId;
    const personalFiles = source(
      `await mail.mailbox("${mailboxRef.id}").draft.create({ senderIdentityId: "${senderId}", to: [{ address: "ben@beispiel.test" }], subject: "Montagsbericht", body: "Bitte Rechnungen prüfen.", idempotencyKey: "draft:2026-025" });`,
    );
    const secret = await code.secretSet(
      {
        codeId,
        name: "BANK",
        value: secretValue,
        binding_revision: null,
        binding: { origin: "https://bank.example", pathPrefix: "/v1", headers: ["authorization"] },
      },
      author,
    );
    expect(JSON.stringify(secret)).not.toContain(secretValue);
    expect(JSON.stringify(await code.secretList({ codeId, limit: 20 }, author))).not.toContain(secretValue);
    const checked = await code.check({ codeId, files: creation, entry: "code.ts" }, author);
    expect(checked.result.ok).toBe(true);
    expect(checked.permissions).toContainEqual(
      expect.objectContaining({
        operation: "spaces.task.create",
        target: space,
        status: "new",
        typeTitle: "Space",
      }),
    );
    const dynamic = await code.check(
      {
        codeId,
        entry: "code.ts",
        files: source(
          `const target: string = String(Date.now()); await spaces.space(target).task.create({ columnId: "${columnId}", title: "Dynamisch", idempotencyKey: "dynamic" });`,
        ),
      },
      author,
    );
    expect(dynamic.result.ok).toBe(true);
    const submitted = await code.submit({ codeId, entry: "code.ts", files: creation, baseVersionId: null }, author);
    const personalVersion = await code.submit({ codeId: personalId, entry: "code.ts", files: personalFiles, baseVersionId: null }, author);
    await approve(submitted.submission);
    await approve(personalVersion.submission);
    const browser = proof(manager);
    const phone: CodeContext = {
      ...browser,
      authority: { ...browser.authority, actor: { kind: "user", user: ben, sessionKind: "app" } },
    };
    await expect(
      activateCodeVersion({ codeId, versionId: submitted.submission.version.id, activationId: crypto.randomUUID() }, phone),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("phone") });
    expect(await sql`SELECT id FROM code.activations WHERE code_id=${codeId}`).toHaveLength(0);
    const account = (await findCode(codeId))!.serviceAccountId!;
    // The manager of the space copies the Kennung from the Code page and finds the account by it, as the access
    // dialog's lookup does once the route admitted the exact handle for a managed target.
    const handle = (await findCode(codeId))!.serviceAccountHandle!;
    const byHandle = await accounts.entities.list({
      visibility: { type: "directory" },
      search: handle,
      codeAccountHandle: handle,
      kinds: ["service_account"],
      serviceAccountStatus: "active",
      locale: "de",
    });
    const found = byHandle.items.find((item) => item.kind === "service_account");
    const foundId = found?.kind === "service_account" ? found.serviceAccount.id : null;
    expect(foundId).toBe(account);
    expect((await accounts.entities.list({ visibility: { type: "directory" }, search: handle, kinds: ["service_account"] })).items).toEqual(
      [],
    );
    expect(
      await spaces.grant({
        spaceId: internalSpaceId,
        principal: { type: "service_account", serviceAccountId: foundId! },
        permission: "write",
        caller: manager,
      }),
    ).toMatchObject({ ok: true });
    await activate(codeId, submitted.submission.version.id, proof(manager));
    await activate(personalId, personalVersion.submission.version.id, proof(author));
    expect(await spaces.accessList(internalSpaceId)).toContainEqual(
      expect.objectContaining({
        serviceAccountKind: "code",
        principal: { type: "service_account", serviceAccountId: account },
        permission: "write",
      }),
    );
    expect(await codeAccountDisplayName((await findCode(codeId))!, manager)).not.toContain("rechnung@beispiel.test");
    expect(await spaces.permission({ spaceId: foreignSpaceId, subject: { type: "user", userId: lea.id } })).toBe("write");
    expect(await spaces.permission({ spaceId: foreignSpaceId, subject: { type: "service_account", serviceAccountId: account } })).toBe(
      "none",
    );
    // Publish the schedule through the real Sync scheduler. The permanent run request is a single delivery.
    const scheduler = sync.scheduler({ id: "acceptance" });
    const createSchedule = scheduler.create.bind(scheduler);
    const registration = spyOn(scheduler, "create").mockImplementation((definition) =>
      createSchedule({
        ...definition,
        // Only this suite's runNow deliveries enter Core; a real Monday cron cannot add a third run.
        process: (tick) => (tick.trigger === "manual" ? definition.process(tick) : Promise.resolve()),
      }),
    );
    restores.push(() => registration.mockRestore());
    await createCodeScheduleReconciler(scheduler)();
    fleet.synchronizeNextPair();
    worker = await scheduler.process();
    const definitions = await scheduler.list();
    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      const tick = await scheduler.runNow({ id: definition.id, requestId: "c25-monday" });
      expect((await scheduler.awaitRun({ id: definition.id, runId: tick.runId, timeoutMs: 5000 })).completed).toBe(true);
    }
    const runs = await sql<{ id: string; code_id: string }[]>`SELECT id,code_id FROM code.runs WHERE code_id IN (${codeId},${personalId})`;
    expect(runs).toHaveLength(2);
    const results = await Promise.all(runs.map((run) => completed(run.code_id, run.id)));
    for (const run of results) {
      expect({ run: run.run, calls: run.calls }).toMatchObject({ run: { state: "succeeded" } });
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.state).toBe("succeeded");
      expect(run.calls[0]?.ordinal).toBe(1);
      expect(run.run.trigger).toBe("schedule");
    }
    expect(new Set(results.map((run) => run.calls[0]?.capability))).toEqual(new Set(["spaces.task.create", "mail.draft.create"]));
    const scheduledRunIds = new Set(runs.map((run) => run.id));
    // One occupied slot per supervisor plus the barrier proves both accepted this scheduled pair.
    expect(fleet.engines.map((engine) => engine.executed.filter((id) => scheduledRunIds.has(id)).length)).toEqual([1, 1]);
    expect(await sql<{ instance_id: string }[]>`SELECT instance_id FROM code.runner_instances ORDER BY instance_id`).toEqual(
      fleet.runners.map((runner) => ({ instance_id: runner.instanceId })).sort((a, b) => a.instance_id.localeCompare(b.instance_id)),
    );
    const repeat = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-repeat" }, author);
    expect((await completed(codeId, repeat.run.runId)).run.state).toBe("succeeded");
    expect(
      await sql`SELECT id FROM spaces.items WHERE space_id=${internalSpaceId}::uuid AND title='Rechnung 2026-025 prüfen'`,
    ).toHaveLength(1);
    expect(await sql`SELECT id FROM mail.drafts WHERE mailbox_id=${mailboxId}::uuid AND subject='Montagsbericht'`).toHaveLength(1);

    // The original literal version independently refuses an injected target.
    const undeclared = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-undeclared" }, author);
    fleet.foreignRuns.set(undeclared.run.runId, { target: { type: "spaces.space", id: foreignId }, status: 403 });
    const undeclaredResult = await completed(codeId, undeclared.run.runId);
    expect(undeclaredResult.run.state).toBe("failed");
    expect(NormalizedCapabilityCallSchema.parse(undeclaredResult.calls[0]?.call).target).toEqual({ type: "spaces.space", id: foreignId });
    expect(undeclaredResult.calls[0]).toMatchObject({
      state: "failed",
      refusalKind: "policy",
      result: { ok: false, error: { code: "code_capability_undeclared" } },
    });
    expect(await sql`SELECT id FROM spaces.items WHERE space_id=${foreignSpaceId}::uuid`).toHaveLength(0);

    // Admit a dynamic target in checked evidence so the foreign-target probe
    // reaches the provider's current account rights rather than the version guard.
    const dynamicVersion = await code.submit(
      {
        codeId,
        entry: "code.ts",
        files: source(
          `const target: string = String("${spaceId}"); await spaces.space(target).task.create({ columnId: "${columnId}", title: "Rechnung 2026-025 prüfen", idempotencyKey: "invoice:2026-025" });`,
        ),
        baseVersionId: submitted.submission.version.id,
      },
      author,
    );
    const [dynamicEvidence] = await sql<
      { permissions: CodeCheckedVersionManifest["permissions"] }[]
    >`SELECT manifest->'permissions' AS permissions FROM code.versions WHERE id=${dynamicVersion.submission.version.id}::uuid`;
    expect(dynamicEvidence?.permissions).toContainEqual(
      expect.objectContaining({ operation: "spaces.task.create", target: { type: "spaces.space", id: null } }),
    );
    await approve(dynamicVersion.submission);
    await activate(codeId, dynamicVersion.submission.version.id, proof(manager));
    const foreign = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-foreign" }, author);
    fleet.foreignRuns.set(foreign.run.runId, { target: { type: "spaces.space", id: foreignId }, status: 200 });
    const foreignResult = await completed(codeId, foreign.run.runId);
    expect(foreignResult.run.state).toBe("failed");
    expect(NormalizedCapabilityCallSchema.parse(foreignResult.calls[0]?.call).target).toEqual({ type: "spaces.space", id: foreignId });
    expect(foreignResult.calls[0]?.result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await sql`SELECT id FROM spaces.items WHERE space_id=${foreignSpaceId}::uuid`).toHaveLength(0);

    // The new immutable version uses current resource rights within its declared scope.
    const updateVersion = await code.submit(
      { codeId, entry: "code.ts", files: update, baseVersionId: dynamicVersion.submission.version.id },
      author,
    );
    await approve(updateVersion.submission);
    await activate(codeId, updateVersion.submission.version.id, proof(manager));
    const amended = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-update" }, author);
    expect((await completed(codeId, amended.run.runId)).run.state).toBe("succeeded");
    const [mandate] = await sql<
      { policy: unknown }[]
    >`SELECT policy FROM auth.mandates WHERE workload_id=${updateVersion.submission.version.id} AND state='active'`;
    expect(mandate!.policy).toBeNull();
    expect(await sql<{ title: string }[]>`SELECT title FROM spaces.items WHERE short_id=${itemId}`).toEqual([
      { title: "Rechnung geprüft" },
    ]);
    await cleanupCodeActivation(codeId);
    const targetGrant = (await spaces.accessList(internalSpaceId))
      .map((entry) => z.object({ id: z.string(), principal: z.unknown() }).parse(entry))
      .find((entry) => JSON.stringify(entry.principal).includes(account))!;
    expect(await spaces.revoke({ spaceId: internalSpaceId, accessId: targetGrant.id, caller: manager })).toMatchObject({ ok: true });
    // Switching the same version on never recreates a revoked share.
    await activate(codeId, updateVersion.submission.version.id, proof(manager));
    expect(await spaces.permission({ spaceId: internalSpaceId, subject: { type: "service_account", serviceAccountId: account } })).toBe(
      "none",
    );
    const revoked = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-revoked" }, author);
    const failed = await completed(codeId, revoked.run.runId);
    expect(failed.run.state).toBe("failed");
    expect(failed.calls[0]).toMatchObject({ state: "failed", result: { ok: false, error: { code: "not_found" } } });
    // Load the real page model through Core queries only: the page asks no other app and reads no target rights.
    const pageApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    pageApp.use("*", async (c, next) => {
      c.set("actor", author.authority.actor);
      c.set("user", lea);
      c.set("accessSubject", author.authority.accessSubject);
      c.set("credentialKind", "session");
      c.set("runtime", { apps: [] });
      await next();
    });
    pageApp.get("/page", async (c) =>
      c.json(
        await loadCodePage(c, {
          owner: { ref: mailboxRef, title: "rechnung@beispiel.test" },
          href: "/page",
          canManageOwner: false,
        }),
      ),
    );
    // Supply the browser credential at the authentication seam; the route still resolves its own authority.
    const pageSession = spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
      token === "c25-page-lea"
        ? {
            user: lea,
            data: { userId: lea.id, sid: crypto.randomUUID(), authEpoch: 0, expiresAt: "2099-01-01T00:00:00.000Z", kind: "web" },
          }
        : null,
    );
    const pageFetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          throw new Error(`The Code page fetched ${new Request(url, init).url}`);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const response = await pageApp.request("/page", { headers: { cookie: "session_token=c25-page-lea" } });
      const pageValue: unknown = await response.json();
      const page = z
        .object({
          state: z.object({
            kind: z.literal("ready"),
            code: z.object({ id: z.string() }),
            refusal: z.object({
              kind: z.string(),
              runId: z.string(),
              call: z.object({
                capability: z.string(),
                target: z.object({
                  ref: z.object({ type: z.string(), id: z.string() }),
                  title: z.string().nullable(),
                  href: z.string().nullable(),
                }),
              }),
            }),
          }),
        })
        .parse(pageValue);
      expect(page.state.code.id).toBe(codeId);
      // The space refused the call with 404: the page states that as a fact, by type and ID, never by name.
      expect(page.state.refusal).toMatchObject({
        kind: "target_refused",
        runId: revoked.run.runId,
        call: { capability: expect.stringContaining("task."), target: { ref: space, title: null } },
      });
      expect(pageFetch).not.toHaveBeenCalled();
    } finally {
      pageFetch.mockRestore();
      pageSession.mockRestore();
    }
    expect(await sql<{ generation: number }[]>`SELECT generation FROM code.runs WHERE id=${revoked.run.runId}::uuid`).toEqual([
      { generation: 1 },
    ]);
    for (const value of [
      secret,
      checked,
      dynamic,
      submitted,
      personalVersion,
      results,
      failed,
      fleet.responses,
      fleet.logs,
      messages,
      await sql`SELECT * FROM code.calls`,
      await sql`SELECT * FROM audit.events`,
    ])
      expect(JSON.stringify(value)).not.toContain(secretValue);

    // Only an ordinary manager share restores access; deletion later removes that live share.
    expect(
      await spaces.grant({
        spaceId: internalSpaceId,
        principal: { type: "service_account", serviceAccountId: account },
        permission: "write",
        caller: manager,
      }),
    ).toMatchObject({ ok: true });
    await activate(codeId, updateVersion.submission.version.id, proof(manager));
    expect(await spaces.permission({ spaceId: internalSpaceId, subject: { type: "service_account", serviceAccountId: account } })).toBe(
      "write",
    );
    expect((await deleteMailbox(manager, mailboxId)).ok).toBe(true);
    for (const row of await codeOwnerDeletedOutbox.claim()) await codeOwnerDeletedOutbox.dispatch(row);
    expect(await findCode(codeId)).toMatchObject({ state: "deleting" });
    for (const row of await codeDeletionOutbox.claim()) await codeDeletionOutbox.dispatch(row);
    const resourceRunIds = [
      ...runs.filter((run) => run.code_id === codeId).map((run) => run.id),
      repeat.run.runId,
      undeclared.run.runId,
      foreign.run.runId,
      amended.run.runId,
      revoked.run.runId,
    ];
    for (const runId of resourceRunIds) expect(await sql`SELECT run_id FROM code.calls WHERE run_id=${runId}::uuid`).toHaveLength(0);
    for (const table of ["codes", "versions", "runs", "secrets", "activations", "cleanup_jobs"]) {
      expect(await sql.unsafe(`SELECT 1 FROM code.${table} WHERE ${table === "codes" ? "id" : "code_id"}=$1`, [codeId])).toHaveLength(0);
    }
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${account}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.access WHERE service_account_id=${account}::uuid`).toHaveLength(0);
    expect(await spaces.accessList(internalSpaceId)).not.toContainEqual(
      expect.objectContaining({ principal: { type: "service_account", serviceAccountId: account } }),
    );
    expect(await findCode(personalId)).not.toBeNull();
  }, 120_000);
  test("real checker evidence binds a secret to an approved version and HTTP echoes/errors stay redacted", async () => {
    const initialized = await code.init({ title: "Privater Bankabruf" }, author);
    const codeId = initialized.config.codeId;
    const stored = await code.secretSet(
      {
        codeId,
        name: "BANK",
        value: secretValue,
        binding_revision: null,
        binding: { origin: "https://bank.example", pathPrefix: "/v1", headers: ["authorization"] },
      },
      author,
    );
    const files = source(`await http.fetch("https://bank.example/v1/echo", { headers: { authorization: "Bearer " + secrets.BANK } });
try { await http.fetch("https://bank.example/v1/error", { headers: { authorization: "Bearer " + secrets.BANK } }); } catch { /* The run handles the visible HTTP refusal. */ }`);
    const checked = await code.check({ codeId, files, entry: "code.ts" }, author);
    if (!checked.result.ok || !checked.manifest) throw new Error("Secret acceptance source did not check");
    expect(checked.manifest.internet).toEqual(["https://bank.example"]);
    expect(checked.manifest.policyRows).toContain("internet");
    // The CLI/chat authoring service selects current bindings; C8 reruns the real checker.
    const submitted = await code.submit({ codeId, entry: "code.ts", files, baseVersionId: null }, author);
    const { configured: _configured, ...binding } = stored.secret;
    const [version] = await sql<{ manifest: { secrets: unknown[]; internet: string[]; policyRows: string[] } }[]>`
      SELECT manifest FROM code.versions WHERE id=${submitted.submission.version.id}::uuid`;
    expect(version!.manifest.secrets).toEqual([binding]);
    expect(version!.manifest.internet).toEqual(["https://bank.example"]);
    expect(version!.manifest.policyRows).toContain("internet");
    expect(submitted.submission.status).toBe("pending");
    // Internet approval is required even for personal Code; activation must leave no state before approval.
    await expect(
      activateCodeVersion({ codeId, versionId: submitted.submission.version.id, activationId: crypto.randomUUID() }, proof(author)),
    ).rejects.toMatchObject({ code: "code_approval_required" });
    expect(await sql`SELECT id FROM code.activations WHERE code_id=${codeId}`).toHaveLength(0);
    await approve(submitted.submission);
    await activate(codeId, submitted.submission.version.id, proof(author));
    const [mandate] = await sql<{ policy: unknown }[]>`
      SELECT policy FROM auth.mandates WHERE workload_id=${submitted.submission.version.id} AND state='active'`;
    expect(mandate!.policy).toBeNull();
    const requested = await code.run({ codeId, entrypoint: "monday", input: null, idempotencyKey: "c25-http" }, author);
    const result = await completed(codeId, requested.run.runId);
    expect(result.run.state).toBe("succeeded");
    expect(sentHttp).toEqual(["https://bank.example/v1/echo", "https://bank.example/v1/error"]);
    expect(result.calls.map((call) => call.state)).toEqual(["succeeded", "failed"]);
    expect(result.calls.map((call) => call.ordinal)).toEqual([1, 2]);
    expect(result.calls[1]?.result).toEqual({ ok: false, error: { code: "code_http_failed" } });
    const body = z.object({ ok: z.literal(true), data: z.object({ body: z.string() }) }).parse(result.calls[0]?.result).data.body;
    const decoded = Buffer.from(body, "base64").toString();
    expect(decoded).toContain("[secret:BANK]");
    expect(decoded).not.toContain(secretValue);
    const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables
      WHERE table_schema='code' AND table_type='BASE TABLE' ORDER BY table_name`;
    const storedRows: unknown[] = [];
    for (const table of tables) {
      // Names come only from this disposable database's catalog; exclude the intentionally stored ciphertext.
      const identifier = '"' + table.table_name.replaceAll('"', '""') + '"';
      storedRows.push(await sql.unsafe(`SELECT to_jsonb(t) - 'encrypted' AS value FROM code.${identifier} t`));
    }
    for (const observed of [
      stored,
      checked,
      submitted,
      result,
      fleet.responses,
      fleet.logs,
      messages,
      await code.secretList({ codeId, limit: 20 }, author),
      storedRows,
      await sql`SELECT * FROM auth.mandates`,
      await sql`SELECT * FROM audit.events`,
    ]) {
      for (const spelling of [secretValue, Buffer.from(secretValue).toString("base64"), encodeURIComponent(secretValue)])
        expect(JSON.stringify(observed)).not.toContain(spelling);
    }
  }, 60_000);
});
