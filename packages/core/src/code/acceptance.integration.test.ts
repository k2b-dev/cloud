import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import { sql } from "@k2b/cloud";
import * as catalog from "@k2b/cloud/capabilities/server";
import { signCodeRunToken } from "@k2b/cloud/code/run-token";
import { type CapabilityExecutionContext, capabilityResultSchema, type User } from "@k2b/cloud/contracts";
import { accounts, coreSettings } from "@k2b/cloud/services";
import { appKeys } from "@k2b/cloud/services/app-keys";
import { codePageMessages } from "@k2b/cloud/ssr/code-page/messages";
import { createSync, type Sync, type Worker } from "@k2b/sync";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import {
  type AcceptanceProvider,
  AcceptanceProviderSchema,
  acceptanceProvider,
} from "../../../../scripts/fixtures/code-acceptance-provider";
import {
  codeAccessProofs,
  signCodeAccessList,
  signCodeAccessProof,
  verifyCodeAccessProof,
} from "../../../../scripts/fixtures/code-platform";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "../../../mail/src/service/auth";
import { acceptanceChecker, acceptanceDispatch, acceptanceRunners } from "./acceptance.test-fixture";
import { type CodeContext, codeAccountDisplayName } from "./access";
import { activateCodeVersion, processCodeActivation, readCodeActivation } from "./activation";
import { cleanupCodeActivation, reconcileCodeAccess } from "./activation-maintenance";
import type { CodeActivationTransport } from "./activation-transport";
import * as activationTransport from "./activation-transport";
import { readCodeAdminApproval } from "./admin";
import { codeAuthoringServices as code } from "./authoring";
import { codeAccessCleanupOutbox, codeDeletionOutbox, codeOwnerDeletedOutbox, processCodeCleanupJob } from "./lifecycle";
import * as runnerHosts from "./runner-jobs";

import { type CodeRunWakeup, createCodeRunOutbox, createCodeScheduleReconciler } from "./scheduling-runtime";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { addCodeShare, findCode, readCodeRun } from "./store";
import type { CodeVersionSubmission } from "./version-contracts";
import { decideCodeVersion, startCodeVersionApprovals, submitCodeVersion } from "./versions";

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
const capabilityContext = (user: User, operation: "set" | "list" | "rm" = "set"): CapabilityExecutionContext => {
  const actor = {
    kind: "user" as const,
    user,
    delegation: {
      kind: "invocation" as const,
      callingAppId: "core",
      credentialKind: "session" as const,
      invocationId: "c25-access",
      codeAccess: operation,
    },
  };
  return {
    actor,
    user,
    accessSubject: { type: "user", userId: user.id },
    authority: { actor, accessSubject: { type: "user", userId: user.id }, credentialKind: "invocation", scopes: [] },
    origin: "app",
    locale: "de",
    requestId: "c25-access",
    signal: new AbortController().signal,
  };
};
const source = (body: string) => ({
  "code.ts": `import { app, spaces, mail, http, secrets } from "@sdk";
app.schedule("0 8 * * 1", async () => {
${body}
}, { name: "monday" });
export default app;`,
});
const creation = source(
  `await spaces.space("${spaceId}").task.create({ columnId: "${columnId}", title: "Rechnung 2026-025 prüfen", idempotencyKey: "invoice:2026-025" });`,
);
const update = source(`await spaces.space("${spaceId}").task.update({ itemId: "${itemId}", title: "Rechnung geprüft" });`);

suiteFor(
  "database",
  "nats",
  "valkey",
)("C25 mailbox schedule acceptance with two stateless runners", () => {
  let lea: User, ben: User, reviewer: User;
  let author: ReturnType<typeof context>, manager: ReturnType<typeof context>;
  let mailboxId: string, mailboxRef: { type: string; id: string }, senderId: string;
  let internalSpaceId: string, foreignSpaceId: string;
  let checker: Awaited<ReturnType<typeof acceptanceChecker>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>, sync: Sync;
  let fleet: Awaited<ReturnType<typeof acceptanceRunners>>;
  let runOutbox: ReturnType<typeof createCodeRunOutbox>;
  let worker: Worker | undefined;
  let transport: CodeActivationTransport;
  let providers: Map<string, AcceptanceProvider>;
  let spaces: AcceptanceProvider & Required<Pick<AcceptanceProvider, "permission" | "accessList">>;
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
    await coreSettings.set("app.timezone", "UTC");
    await coreSettings.set("security.rate_limit_per_second", 60);
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
    const reader = spyOn(catalog, "invokeCapabilityWithDataSchema").mockImplementation(async (input, schema, caller) => {
      if (!caller.authority) throw new Error("Reader needs authority");
      const provider = providers.get(input.appId)!;
      const response = await provider.invoke({
        kind: "query",
        localId: input.capabilityId,
        input: input.input,
        expectedSchemaHash: provider.manifest.queries.find((op) => op.localId === input.capabilityId)!.schemaHash,
        context: {
          authority: caller.authority,
          actor: caller.authority.actor,
          accessSubject: caller.authority.accessSubject,
          user: caller.authority.actor.kind === "user" ? caller.authority.actor.user : null,
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
    const verifyInspection = codeAccessProofs.verifyCodeAccessList;
    const inspectionKeys = spyOn(codeAccessProofs, "verifyCodeAccessList").mockImplementation((token, appId) =>
      verifyInspection(token, appId, { issuer, key }),
    );
    restores.push(() => inspectionKeys.mockRestore());
    transport = {
      set: async ({ item, dryRun, ...proof }) => {
        const appId = item.target.type.split(".")[0]!;
        const token = await signCodeAccessProof(
          appId,
          { ...proof, grantId: item.grantId, target: item.target, operations: item.operations },
          { issuer, signer },
        );
        return providers.get(appId)!.set({
          input: { proof: token, target: item.target, operations: item.operations, dryRun },
          context: capabilityContext(ben),
          dependencies: {
            db: sql,
            verifyProof: (value: string, expected: Parameters<typeof verifyCodeAccessProof>[1]) =>
              verifyCodeAccessProof(value, expected, { issuer, key }),
          },
        });
      },
      list: (id, principal) => providers.get(id)!.list({ principal, authority: { listPrincipal: principal } }),
      // Only Cloud-admin activation notifies target managers; the story's activations are by managers.
      notificationManagers: async () => [],
      remove: async (id, principal, grantId) => {
        expect(await providers.get(id)!.remove({ grantId, authority: { cleanupPrincipal: principal, requestId: "c25-cleanup" } })).toBe(
          true,
        );
      },
    };
    // The shared authoring service still invokes the real isolated checker. This fixture only replaces its network hop.
    checker = await acceptanceChecker();
    const checkHost = spyOn(runnerHosts, "createRunnerCodeCheckHost").mockReturnValue({ check: checker.check });
    restores.push(() => checkHost.mockRestore());
    const listingTransport = spyOn(activationTransport.codeActivationTransport, "list").mockImplementation(transport.list);
    restores.push(() => listingTransport.mockRestore());
    const ownerTitle = spyOn(activationTransport, "readCodeResourceOwnerTitle").mockImplementation(async (ref, principal) => {
      const appId = ref.type.split(".")[0]!;
      const token = await signCodeAccessList(appId, principal, { issuer, signer });
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
    const queue = sync.queue<CodeRunWakeup>({ id: "runs", retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 } });
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
        if (String(input.url).endsWith("/public")) {
          expect(input.headers.authorization).toBeUndefined();
          sentHttp.push(String(input.url));
          return { status: 200, headers: { etag: "public" }, body: Buffer.from("public result") };
        }
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
      transport,
      catalog: async (id) => ((await catalog.getCapabilityCatalogApp(id)).ok ? (providers.get(id)?.manifest ?? null) : null),
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
        needsTargetAdmin: true,
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
    expect(dynamic.result.ok).toBe(false);
    if (!dynamic.result.ok) expect(dynamic.result.diagnostics).toContainEqual(expect.objectContaining({ code: "code_dynamic_target" }));
    const submitted = await code.submit({ codeId, entry: "code.ts", files: creation, baseVersionId: null }, author);
    const personalVersion = await code.submit({ codeId: personalId, entry: "code.ts", files: personalFiles, baseVersionId: null }, author);
    const phone: CodeContext = { ...manager, authority: { ...manager.authority, actor: { kind: "user", user: ben, sessionKind: "app" } } };
    await expect(
      activateCodeVersion({ codeId, versionId: submitted.submission.version.id, activationId: crypto.randomUUID() }, phone),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await sql`SELECT id FROM code.activations WHERE code_id=${codeId}`).toHaveLength(0);
    await approve(submitted.submission);
    await approve(personalVersion.submission);
    await activate(codeId, submitted.submission.version.id, proof(manager));
    await activate(personalId, personalVersion.submission.version.id, proof(author));
    const account = (await findCode(codeId))!.serviceAccountId!;
    expect(await spaces.accessList(internalSpaceId)).toContainEqual(
      expect.objectContaining({
        serviceAccountKind: "code",
        principal: { type: "service_account", serviceAccountId: account },
        permission: "write",
      }),
    );
    expect(await codeAccountDisplayName((await findCode(codeId))!, manager)).toBe("Code von rechnung@beispiel.test");
    expect(await spaces.permission({ spaceId: foreignSpaceId, subject: { type: "user", userId: lea.id } })).toBe("write");
    expect(await spaces.permission({ spaceId: foreignSpaceId, subject: { type: "service_account", serviceAccountId: account } })).toBe(
      "none",
    );
    // Publish the schedule through the real Sync scheduler. The permanent run request is a single delivery.
    const scheduler = sync.scheduler({ id: "acceptance" });
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
      expect(run.run.state).toBe("succeeded");
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.state).toBe("succeeded");
    }
    expect(new Set(results.map((run) => run.calls[0]?.capability))).toEqual(new Set(["spaces.task.create", "mail.draft.create"]));
    expect(fleet.engines.every((engine) => engine.executed.length > 0)).toBe(true);
    expect(await sql`SELECT instance_id FROM code.runner_instances`).toHaveLength(2);
    const repeat = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-repeat" }, author);
    expect((await completed(codeId, repeat.run.runId)).run.state).toBe("succeeded");
    expect(
      await sql`SELECT id FROM spaces.items WHERE space_id=${internalSpaceId}::uuid AND title='Rechnung 2026-025 prüfen'`,
    ).toHaveLength(1);
    expect(await sql`SELECT id FROM mail.drafts WHERE mailbox_id=${mailboxId}::uuid AND subject='Montagsbericht'`).toHaveLength(1);

    const foreign = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-foreign" }, author);
    fleet.foreignRuns.set(foreign.run.runId, { type: "spaces.space", id: foreignId });
    const foreignResult = await completed(codeId, foreign.run.runId);
    expect(foreignResult.run.state).toBe("failed");
    expect(foreignResult.calls[0]?.call?.target).toEqual({ type: "spaces.space", id: foreignId });
    expect(foreignResult.calls[0]?.result).toMatchObject({ ok: false, error: { code: "mandate_forbidden" } });
    expect(await sql`SELECT id FROM spaces.items WHERE space_id=${foreignSpaceId}::uuid`).toHaveLength(0);

    // A new immutable version has update authority only: successful updates cannot depend on task.create.
    const updateVersion = await code.submit(
      { codeId, entry: "code.ts", files: update, baseVersionId: submitted.submission.version.id },
      author,
    );
    await approve(updateVersion.submission);
    await activate(codeId, updateVersion.submission.version.id, proof(manager));
    const amended = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-update" }, author);
    expect((await completed(codeId, amended.run.runId)).run.state).toBe("succeeded");
    const [mandate] = await sql<
      { policy: { operations: string[] } }[]
    >`SELECT policy FROM auth.mandates WHERE workload_id=${updateVersion.submission.version.id} AND state='active'`;
    expect(mandate!.policy.operations).toContain("capability.action.run:task.update");
    expect(mandate!.policy.operations).not.toContain("capability.action.run:task.create");
    expect(await sql<{ title: string }[]>`SELECT title FROM spaces.items WHERE short_id=${itemId}`).toEqual([
      { title: "Rechnung geprüft" },
    ]);
    await cleanupCodeActivation(codeId, transport, async () => {});
    const access = await reconcileCodeAccess({ codeId }, author, transport);
    const targetGrant = access.find((grant) => grant.target.type === space.type && grant.target.id === space.id)!;
    expect(await spaces.remove({ grantId: targetGrant.grantId, authority: { context: capabilityContext(ben, "rm") } })).toBe(true);
    expect(await reconcileCodeAccess({ codeId }, author, transport)).toContainEqual(
      expect.objectContaining({ target: space, state: "removed" }),
    );
    const revoked = await code.run({ codeId, input: null, entrypoint: "monday", idempotencyKey: "c25-revoked" }, author);
    const failed = await completed(codeId, revoked.run.runId);
    expect(failed.run.state).toBe("failed");
    expect(failed.calls[0]).toMatchObject({ state: "failed", result: { ok: false, error: { code: "not_found" } } });
    expect(codePageMessages.resolve(["de"]).t.removed).toBe("Zugriff entfernt");
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

    expect((await deleteMailbox(manager, mailboxId)).ok).toBe(true);
    for (const row of await codeOwnerDeletedOutbox.claim()) await codeOwnerDeletedOutbox.dispatch(row);
    expect(await findCode(codeId)).toMatchObject({ state: "deleting" });
    const cleanupDeadline = AbortSignal.timeout(10_000);
    while (true) {
      cleanupDeadline.throwIfAborted();
      const rows = await codeAccessCleanupOutbox.claim();
      if (!rows.length) break;
      for (const row of rows) await codeAccessCleanupOutbox.dispatch(row, (job) => processCodeCleanupJob(job, transport));
    }
    for (const row of await codeDeletionOutbox.claim()) await codeDeletionOutbox.dispatch(row);
    const resourceRunIds = [
      ...runs.filter((run) => run.code_id === codeId).map((run) => run.id),
      repeat.run.runId,
      foreign.run.runId,
      amended.run.runId,
      revoked.run.runId,
    ];
    for (const runId of resourceRunIds) expect(await sql`SELECT run_id FROM code.calls WHERE run_id=${runId}::uuid`).toHaveLength(0);
    for (const table of ["codes", "versions", "runs", "secrets", "activations", "target_grants", "cleanup_jobs"]) {
      expect(await sql.unsafe(`SELECT 1 FROM code.${table} WHERE ${table === "codes" ? "id" : "code_id"}=$1`, [codeId])).toHaveLength(0);
    }
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${account}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.access WHERE service_account_id=${account}::uuid`).toHaveLength(0);
    expect(await transport.list("spaces", account)).toEqual([]);
    expect(await transport.list("mail", account)).toEqual([]);
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
    const { configured: _configured, ...binding } = stored.secret;
    // C11's documented selected-binding seam; C8 still reruns the real checker before accepting it.
    const submitted = await submitCodeVersion(
      {
        codeId,
        sourceFiles: files,
        bundle: checked.result.bundle,
        manifest: { ...checked.manifest, secrets: [binding] },
        baseVersionId: null,
      },
      author,
    );
    await approve(submitted);
    await activate(codeId, submitted.version.id, proof(author));
    const requested = await code.run({ codeId, entrypoint: "monday", input: null, idempotencyKey: "c25-http" }, author);
    const result = await completed(codeId, requested.run.runId);
    expect(result.run.state).toBe("succeeded");
    expect(sentHttp).toEqual(["https://bank.example/v1/echo", "https://bank.example/v1/error"]);
    expect(result.calls.map((call) => call.state)).toEqual(["succeeded", "failed"]);
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
  test("declared HTTP without a secret checks, submits, approves and activates for personal and resource Code", async () => {
    const mailbox = await createMailbox(manager, { name: "Internet fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id=${mailbox.data.id}::uuid`;
    const resource = { kind: "resource" as const, ref: { type: "mail.mailbox", id: row!.short_id } };
    for (const owner of [undefined, resource]) {
      const caller = owner ? manager : author;
      const initialized = await code.init({ title: "Origin fixture", ...(owner ? { owner } : {}) }, caller);
      const codeId = initialized.config.codeId;
      const files = source(`const url: string = ["https:", "", "bank.example", "public"].join("/");
await http.fetch(url);
try { await http.fetch(url.replace("bank.example", "undeclared.example")); } catch (error) {
  if (!(error instanceof Error) || !error.message.includes("https://undeclared.example")) throw error;
}`);
      files["code.ts"] = files["code.ts"]!.replace("app.schedule", 'http.allow(["https://bank.example"]);\napp.schedule');
      const checked = await code.check({ codeId, files, entry: "code.ts" }, caller);
      expect(checked.manifest?.internet).toEqual(["https://bank.example"]);
      expect(checked.manifest?.policyRows).toEqual(["internet"]);
      const submitted = (await code.submit({ codeId, files, entry: "code.ts", baseVersionId: null }, caller)).submission;
      expect(submitted.status).toBe("pending");
      expect((await readCodeAdminApproval(submitted.version.id, context(reviewer))).internet).toEqual(["https://bank.example"]);
      await approve(submitted);
      await activate(codeId, submitted.version.id, proof(caller));
      const requested = await code.run({ codeId, entrypoint: "monday", input: null, idempotencyKey: "c11b-public" }, caller);
      const result = await completed(codeId, requested.run.runId, caller);
      expect(result.run.state).toBe("succeeded");
      expect(result.calls.map((call) => call.state)).toEqual(["succeeded", "failed"]);
      expect(result.calls[1]?.result).toEqual({
        ok: false,
        error: { code: "code_http_origin_undeclared", origin: "https://undeclared.example" },
      });
    }
    expect(sentHttp.filter((url) => url === "https://bank.example/public")).toHaveLength(2);
    expect(sentHttp.some((url) => url.startsWith("https://undeclared.example"))).toBe(false);
  }, 60_000);
});
