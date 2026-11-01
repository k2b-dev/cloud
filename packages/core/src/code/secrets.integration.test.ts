import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as registry from "@k2b/cloud";
import { connections, sql } from "@k2b/cloud";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { CodeHttpRequestSchema, type CodeSecretVersionBinding, type User } from "@k2b/cloud/contracts";
import { mandates, purposeSecretCipher, type requestPublicHttps } from "@k2b/cloud/services";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateSecrets } from "../migrate/core/code-secrets";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { type CodeContext, CodeDataError } from "./access";
import { createCodeBridgeHost } from "./bridge";
import * as origins from "./origins";
import { dispatchCodeSecretHttp } from "./secret-http";
import {
  CODE_SECRET_PURPOSE,
  codeSecretContext,
  deleteCodeSecret,
  listCodeSecrets,
  reencryptCodeSecretBatch,
  reviewCodeSecretDeletion,
  setCodeSecret,
} from "./secrets";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash, readCodeRun } from "./store";
import { decideCodeVersion, diffCodeVersion, startCodeVersionApprovals, submitCodeVersion } from "./versions";

const fixed = new Date("2026-11-01T12:00:00Z");
const authorId = "11111111-1111-4111-8111-111111111111",
  reviewerId = "22222222-2222-4222-8222-222222222222";
const person = (id: string): User => ({
  id,
  uid: id,
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = (id = authorId): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
});
const destination = { origin: "https://api.example:8443", pathPrefix: "/v1", headers: ["authorization"] };

databaseSuite()("C11 version-bound write-only secrets", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let ownOrigins: ReturnType<typeof spyOn<typeof origins, "readCodeOwnOrigins">>;
  let app: ReturnType<typeof spyOn<typeof registry, "getApp">>;
  let stopApprovals: (() => void) | undefined;
  let ordinal = 0;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("code_secrets_c11");
    await migrateAuth();
    await migrateAppApproval();
    await migrateSettings();
    await migrateAudit();
    await migrateCode();
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    await migrateSecrets();
    for (const id of [authorId, reviewerId])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',true)`;
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) => CODE_SETTINGS[key].default);
    ownOrigins = spyOn(origins, "readCodeOwnOrigins").mockResolvedValue(["https://cloud.example"]);
    app = spyOn(registry, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-code",
      description: "Fixture",
      baseUrl: "https://cloud.example",
      routes: [],
      access: { kind: "signedIn" },
    }));
    stopApprovals = startCodeVersionApprovals();
  });
  afterAll(async () => {
    stopApprovals?.();
    settings?.mockRestore();
    ownOrigins?.mockRestore();
    app?.mockRestore();
    await database?.drop();
    setSystemTime();
  });
  async function fixture(value = "test-only-private-credential") {
    const codeId = `c_c11${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${codeId},'person',${authorId}::uuid,'Fixture',${authorId}::uuid)`;
    const { secret } = await setCodeSecret({ codeId, name: "API", binding_revision: null, binding: destination, value }, context());
    expect(JSON.stringify(secret)).not.toContain(value);
    const { configured: _configured, ...binding } = secret;
    return { codeId, secret, binding };
  }
  async function submit(codeId: string, binding: CodeSecretVersionBinding, baseVersionId: string | null = null) {
    const sourceFiles = { "code.ts": "export const weekly = () => {};" },
      bundle = "export const weekly = () => {};";
    return submitCodeVersion(
      {
        codeId,
        sourceFiles,
        bundle,
        baseVersionId,
        manifest: {
          version: 1,
          entry: "code.ts",
          entrypoints: [{ kind: "manual", entrypoint: "weekly", cron: null, file: "code.ts", line: 1 }],
          permissions: [],
          ai: false,
          internet: true,
          policyRows: ["internet"],
          secrets: [binding],
          hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
        },
      },
      context(),
    );
  }
  async function running(codeId: string, binding: CodeSecretVersionBinding) {
    const submission = await submit(codeId, binding);
    expect(submission.status).toBe("pending");
    await decideCodeVersion(submission.binding, true, context(reviewerId));
    await sql`UPDATE code.codes SET active_version_id=${submission.version.id}::uuid,state='active' WHERE id=${codeId}`;
    const mandate = await mandates.create({
      authority: { kind: "admin", userId: authorId },
      subject: { type: "user", id: authorId },
      ownerAppId: "core",
      workloadType: "code.version",
      workloadId: submission.version.id,
      policy: {
        version: 1,
        apps: ["core"],
        operations: ["runtime.http"],
        actions: "preapproved",
        grants: [{ kind: "http", fixedInput: {} }],
      },
    });
    if (!mandate.ok) throw new Error(mandate.error.code);
    const [run] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit)
      VALUES(${codeId},${submission.version.id}::uuid,'manual','weekly','running',clock_timestamp(),clock_timestamp()+interval '10 minutes',1,32768,200) RETURNING id`;
    const seconds = Math.floor(fixed.getTime() / 1000);
    const claims: CodeRunTokenClaims = {
      ver: 1,
      token_use: "code_run",
      iss: "https://cloud.example",
      aud: "cloud-code-bridge",
      iat: seconds,
      nbf: seconds,
      exp: seconds + 300,
      codeId,
      versionId: submission.version.id,
      runId: run!.id,
      generation: 1,
      entrypoint: "weekly",
      mandateId: mandate.data.id,
      mandateRevision: mandate.data.revision,
      bundleHash: submission.binding.bundleHash,
    };
    return { claims, submission };
  }
  const request = (url = destination.origin + "/v1/items") =>
    CodeHttpRequestSchema.parse({ url, method: "POST", headers: { authorization: "Bearer [secret:API]" }, body: "{}" });
  const invoke = (claims: CodeRunTokenClaims, send: typeof requestPublicHttps, url?: string) => {
    const req = request(url);
    return createCodeBridgeHost({ checkRate: async () => ({ limited: false }) }).withCall(
      { claims, kind: "internet", call: { capability: "http.fetch", target: null, refs: {}, input: req } },
      (authority) =>
        dispatchCodeSecretHttp(
          { claims, request: req, authority, ownOrigins: ["https://cloud.example"], signal: new AbortController().signal },
          send,
        ),
    );
  };
  test("metadata, runner response, ordered calls, audit, logs and errors never contain inserted values", async () => {
    const { codeId, binding } = await fixture();
    const { claims } = await running(codeId, binding);
    const value = "test-only-private-credential";
    const messages: unknown[] = [];
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    for (const log of logs)
      log.mockImplementation((...args) => {
        messages.push(args);
      });
    try {
      const response = await invoke(claims, async (input) => {
        expect(input.headers.authorization).toBe("Bearer " + value);
        return { status: 200, headers: { etag: value }, body: Buffer.from(JSON.stringify({ echo: value })) };
      });
      const text = await response.text();
      expect(text).not.toContain(value);
      expect(Buffer.from(JSON.parse(text).data.body, "base64").toString()).toContain("[secret:API]");
      const failed = await invoke(claims, async () => {
        throw new Error(value);
      });
      expect(await failed.json()).toEqual({ ok: false, error: { code: "code_http_failed" } });
      expect(JSON.stringify(await listCodeSecrets({ codeId }, context()))).not.toContain(value);
      expect(
        JSON.stringify(await reviewCodeSecretDeletion({ codeId, name: "API", binding_revision: binding.binding_revision }, context())),
      ).not.toContain(value);
      const run = await readCodeRun({ codeId, runId: claims.runId, cursor: 0, offset: 0, length: 16384 }, context());
      expect(JSON.stringify(run)).not.toContain(value);
      const rawCalls = await sql`SELECT * FROM code.calls WHERE run_id=${claims.runId}::uuid`;
      expect(JSON.stringify(rawCalls)).not.toContain(value);
      expect(rawCalls[0]?.kind).toBe("action");
      expect(JSON.stringify(await sql`SELECT * FROM audit.events`)).not.toContain(value);
      expect(JSON.stringify(messages)).not.toContain(value);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
  test("a changed destination stays ineffective for an approved version, while a new value applies immediately", async () => {
    const { codeId, secret, binding } = await fixture("old-value-credential");
    const { claims, submission } = await running(codeId, binding);
    const changed = await setCodeSecret(
      {
        codeId,
        name: "API",
        binding_revision: secret.binding_revision,
        binding: { ...destination, origin: "https://new.example" },
        value: "new-value-credential",
      },
      context(),
    );
    expect(changed.secret.binding_revision).not.toBe(binding.binding_revision);
    let count = 0;
    const send: typeof requestPublicHttps = async (input) => {
      count++;
      expect(input.headers.authorization).toBe("Bearer new-value-credential");
      return { status: 204, headers: {}, body: new Uint8Array() };
    };
    expect(await (await invoke(claims, send)).json()).toMatchObject({ ok: true });
    expect(await (await invoke(claims, send, "https://new.example/v1/items")).json()).toEqual({
      ok: false,
      error: { code: "code_http_secret_forbidden" },
    });
    expect(count).toBe(1);
    const { configured: _configured, ...newBinding } = changed.secret;
    const pending = await submit(codeId, newBinding, submission.version.id);
    expect(pending.status).toBe("pending");
    expect((await diffCodeVersion({ codeId, versionId: pending.version.id }, context())).secrets).toEqual([newBinding]);
    const cleared = await deleteCodeSecret({ codeId, name: "API", binding_revision: changed.secret.binding_revision }, context());
    expect(cleared.deleted).toBe(true);
    expect(await (await invoke(claims, send)).json()).toEqual({ ok: false, error: { code: "code_http_secret_unavailable" } });
    expect(count).toBe(1);
  });
  test("slow network effects hold no issuance locks on runs, Code edits or values", async () => {
    const { codeId, secret, binding } = await fixture();
    const { claims } = await running(codeId, binding);
    const response = await invoke(claims, async () => {
      // These would time out if the network callback still owned C4's issuance transaction.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='1s'`.simple();
        await tx`UPDATE code.runs SET lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=${claims.runId}::uuid`;
        await tx`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
        await tx`SELECT name FROM code.secrets WHERE code_id=${codeId} FOR UPDATE`;
      });
      await setCodeSecret({ codeId, name: "API", binding_revision: secret.binding_revision, value: "replacement" }, context());
      return { status: 204, headers: {}, body: new Uint8Array() };
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });
  test("metadata and all mutations require an editor, including for Cloud administrators", async () => {
    const { codeId, secret } = await fixture();
    for (const operation of [
      () => listCodeSecrets({ codeId }, context(reviewerId)),
      () => setCodeSecret({ codeId, name: "API", binding_revision: secret.binding_revision, value: "replacement" }, context(reviewerId)),
      () => deleteCodeSecret({ codeId, name: "API", binding_revision: secret.binding_revision }, context(reviewerId)),
    ])
      await expect(operation()).rejects.toBeInstanceOf(CodeDataError);
    await expect(setCodeSecret({ codeId, name: "API", binding_revision: null, value: "replacement" }, context())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      setCodeSecret(
        {
          codeId,
          name: "OWN",
          binding_revision: null,
          value: "replacement",
          binding: {
            ...destination,
            origin: "https://cloud.example",
          },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    const delegated = context();
    delegated.authority.credentialKind = "invocation";
    delegated.authority.actor.delegation = {
      kind: "invocation",
      callingAppId: "example",
      credentialKind: "mandate",
      invocationId: authorId,
    };
    await expect(
      setCodeSecret({ codeId, name: "API", binding_revision: secret.binding_revision, value: "replacement" }, delegated),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("historical binding evidence is immutable, submission refuses foreign evidence and root re-encryption preserves current decryptability", async () => {
    const { codeId, binding } = await fixture();
    await migrateSecrets();
    await expect(sql`UPDATE code.secret_bindings SET binding='{}'::jsonb WHERE code_id=${codeId}`).rejects.toThrow("immutable");
    const other = await fixture();
    await expect(submit(other.codeId, binding)).rejects.toBeInstanceOf(CodeDataError);
    const before = await sql<{ encrypted: string }[]>`SELECT encrypted FROM code.secrets WHERE code_id=${codeId}`;
    const roots = { previous: connections().appSecret.current, current: "c11-new-test-only-root" };
    const snapshot = await sql<{ code_id: string; name: string; encrypted: string }[]>`
      SELECT code_id,name,encrypted FROM code.secrets WHERE encrypted IS NOT NULL ORDER BY code_id,name`;
    const damaged = snapshot.find((row) => row.code_id === other.codeId)!;
    await sql`UPDATE code.secrets SET encrypted='unreadable-fixture' WHERE code_id=${other.codeId}`;
    await expect(reencryptCodeSecretBatch({ limit: 50 }, sql, roots)).rejects.toMatchObject({ code: "CONFLICT" });
    const unchanged = await sql`SELECT code_id,name,encrypted FROM code.secrets
      WHERE encrypted IS NOT NULL AND code_id<>${other.codeId} ORDER BY code_id,name`;
    expect([...unchanged]).toEqual(snapshot.filter((row) => row.code_id !== other.codeId));
    await sql`UPDATE code.secrets SET encrypted=${damaged.encrypted} WHERE code_id=${other.codeId}`;
    let cursor: { codeId: string; name: string } | undefined;
    do {
      const page = await reencryptCodeSecretBatch({ cursor, limit: 2 }, sql, roots);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const after = await sql<{ encrypted: string }[]>`SELECT encrypted FROM code.secrets WHERE code_id=${codeId}`;
    expect(after[0]!.encrypted).not.toBe(before[0]!.encrypted);
    const current = purposeSecretCipher(CODE_SECRET_PURPOSE, { current: roots.current });
    expect(current.decrypt(after[0]!.encrypted, codeSecretContext(codeId, "API"))).toBe("test-only-private-credential");
    expect(() => current.decrypt(before[0]!.encrypted, codeSecretContext(codeId, "API"))).toThrow("secret_unreadable");
  });
});
