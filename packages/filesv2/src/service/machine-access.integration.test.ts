import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { type AccessSubject, type AuthContext, auth, type RequestActor, type RequestAuthority, requireInvocation } from "@k2b/cloud/server";
import { accounts, coreSettings, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { Filegate } from "@k2b/filegate";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { useTestAppRegistry } from "../../../../scripts/fixtures/app-registry";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { invocationAuthorityFromRequest } from "@k2b/cloud/services/identity/invocation-authority";
import { issueInvocationToken } from "@k2b/cloud/services/identity/issue-invocation";
import { activityFilegate } from "../../test/activity-filegate";
import { testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import api from "../api";
import { app } from "../config";
import type { EntriesResult, OfficeEditorLaunch } from "../contracts";
import { entryRef } from "../data/references";
import { uploads } from "../data/uploads";
import { fileActions, fileQueries } from "../file-capabilities";
import { migrate } from "../migrate";
import { publicApi } from "../public";
import { filesService as service } from ".";
import { verifyEditorToken } from "./collabora";
import { FilesRoot } from "./filegate-facade";
import { templateService } from "./templates";

useTestAppRegistry(["filesv2"]);

const suite = suiteFor("database", "nats", "valkey");
suite("Files machine storage through actual API tokens", () => {
  let runtime: ProcessSync | undefined;
  let gateway: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let admin: Extract<RequestActor, { kind: "user" }>;
  let personalAccountId: string;
  let client: Filegate;
  let office: ReturnType<typeof Bun.serve> | undefined;
  let oauthPrivateKey: CryptoKey;
  let oauthPublicKey: Awaited<ReturnType<typeof exportJWK>>;
  const oauthKid = "d2b94f53-f6d2-4b4f-9e90-e5bbd0f3ce10";
  const originalIdentityOrigin = process.env.CLOUD_IDENTITY_JWKS_ORIGIN;
  const originalJwksOrigin = process.env.CLOUD_OAUTH_JWKS_ORIGIN;
  const prefix = `machine-access-${Bun.randomUUIDv7()}`;
  const call = () => testCall(admin);
  const publicRoutes = new Hono<AuthContext>()
    .use("*", requireAppAccess(app.meta, async (c, message) => c.text(message, 403)))
    .route("/share/filesv2", publicApi);
  // Every synthetic client gets an independent per-IP budget in shared test Valkey.
  const publicRequest = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-real-ip", uniqueCallerAddress());
    return publicRoutes.request(`/share/filesv2${path}`, { ...init, headers });
  };
  async function token(id: string, scopes: string[]) {
    const result = await serviceAccountCredentials.createStandaloneApiToken({
      serviceAccountId: id,
      actor: admin.user,
      name: "Files fixture",
      scopes,
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  }
  const request = (key: string, path: string, method = "GET", body?: unknown) =>
    api.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": "machine-files-fixture", "x-real-ip": uniqueCallerAddress() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function data<T>(response: Response): Promise<T> {
    expect(response.status).toBe(200);
    return response.json();
  }
  async function denied(response: Response) {
    expect([401, 403, 404]).toContain(response.status);
  }
  const capture = new Hono<AuthContext>()
    .use(auth.requireRole("authenticated"))
    .get("/", (c) => c.json({ actor: c.get("actor"), subject: c.get("accessSubject"), authority: auth.getAuthority(c) }));
  async function capabilityContext(key: string): Promise<CapabilityExecutionContext> {
    const identity = await data<{ actor: RequestActor; subject: AccessSubject }>(
      await capture.request("/", { headers: { authorization: `Bearer ${key}` } }),
    );
    return {
      actor: identity.actor,
      accessSubject: identity.subject,
      user: null,
      locale: "en",
      origin: "http",
      requestId: "machine-capability-fixture",
      signal: new AbortController().signal,
      idempotencyKey: Bun.randomUUIDv7(),
    };
  }
  async function revokedPublication(share: { id: string; url: string }, directory: string, revoke: () => Promise<unknown>) {
    const racingToken = new URL(share.url).pathname.split("/").at(-1)!;
    const racingUpload = await service.publicInboxUpload(racingToken, {
      name: "revoked-publication.txt",
      size: 3,
      idempotencyKey: Bun.randomUUIDv7(),
    });
    const racingPath = new URL(racingUpload.url!).pathname.replace("/share/filesv2", "");
    expect((await publicRequest(`${racingPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
    const reservation = await uploads.getForShare(racingUpload.id, share.id);
    if (!reservation?.filegate_session_id) throw new Error("Missing Filegate session receipt");
    const sessionId = reservation.filegate_session_id;
    let inspected = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalSession = FilesRoot.prototype.session;
    const inspection = spyOn(FilesRoot.prototype, "session").mockImplementation(async function (this: FilesRoot, ...args) {
      const session = await originalSession.apply(this, args);
      // First inspection reconciles the receipt; the second precedes publication.
      if (args[0] === sessionId && ++inspected === 2) {
        entered.resolve();
        await release.promise;
      }
      return session;
    });
    const committing = service.publicInboxCommit(racingToken, racingUpload.id).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await Promise.race([
        entered.promise,
        committing.then(() => {
          throw new Error("Commit finished before the inspection barrier");
        }),
      ]);
      await revoke();
      release.resolve();
      expect((await committing).error).toMatchObject({ status: 404 });
      expect((await uploads.getForShare(racingUpload.id, share.id))?.state).toBe("open");
      await expect(service.publicInboxCommit(racingToken, racingUpload.id)).rejects.toMatchObject({ status: 404 });
      await expect(client.root("cloud").stat(`${directory}/revoked-publication.txt`)).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      release.resolve();
      await committing;
      inspection.mockRestore();
    }
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    // Use real Core schemas and public services; no stand-in authentication or grant resolver.
    for (const name of ["auth", "rail-preferences", "rail-shortcuts", "settings", "audit", "logging"]) {
      const path = `../../../core/src/migrate/core/${name}.ts`;
      const module = await import(path);
      await module.migrate();
    }
    const { migrate: migrateOAuth } = await import("../../../oauth/src/migrate");
    await migrateOAuth();
    await migrate();
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    setSystemTime(clock!.now);
    const pair = await generateKeyPair("RS256", { extractable: true });
    oauthPrivateKey = pair.privateKey;
    oauthPublicKey = await exportJWK(pair.publicKey);
    const adminId = Bun.randomUUIDv7();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name) VALUES(${adminId}::uuid,'files-machine-admin','local','user',true,'Fixture administrator')`;
    const user = await accounts.users.get({ id: adminId });
    if (!user) throw new Error("Missing administrator");
    admin = { kind: "user", user };
    const personalAccount = await serviceAccounts.createUserDelegated({ name: "Personal Files fixture", delegatedUserId: user.id });
    if (!personalAccount.ok) throw new Error("Delegated fixture account failed");
    personalAccountId = personalAccount.data.id;
    await coreSettings.set("app.url", "http://files-machine.test");
    runtime = await startProcessSync({ application: "filesv2" });
    gateway = await activityFilegate();
    client = new Filegate({ baseUrl: gateway.url, token: gateway.token, transferBaseUrl: gateway.url });
    await client.root("cloud").mkdir(prefix, { ownership: { dirMode: "0700" } });
    office = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname.startsWith("/.well-known/")
          ? Response.json({ keys: [{ ...oauthPublicKey, kid: oauthKid, alg: "RS256", use: "sig" }] })
          : new Response(
              `<wopi-discovery><net-zone name="external-http"><app name="writer"><action ext="odt" name="edit" urlsrc="https://office.example.test/browser/editor?"/><action ext="odt" name="view" urlsrc="https://office.example.test/browser/editor?"/></app></net-zone></wopi-discovery>`,
            ),
    });
    process.env.CLOUD_OAUTH_JWKS_ORIGIN = office.url.origin;
    process.env.CLOUD_IDENTITY_JWKS_ORIGIN = office.url.origin;
    await service.saveConfiguration(call(), {
      url: gateway.url,
      token: gateway.token,
      activityRetentionDays: 365,
      cloud: {
        enabled: true,
        root: "cloud",
        prefix,
        homes: "users",
        groups: "groups",
        archive: "archive",
        autoCreate: false,
        autoArchive: true,
      },
      freeipa: { enabled: false, root: "freeipa", prefix, homes: "users", groups: "groups", archive: "archive" },
      collabora: { url: "https://office.example.test", internalUrl: office.url.origin, wopiOrigin: "", documentFormat: "odf" },
    });
  }, 60000);
  afterAll(async () => {
    if (client)
      await client
        .root("cloud")
        .remove(prefix, true)
        .catch(() => undefined);
    const rateKeys = await redis.send("KEYS", [`cloud:rate-limit:*:ip:${publicIpPrefix}*`]);
    if (Array.isArray(rateKeys)) for (const key of rateKeys) if (typeof key === "string") await redis.del(key);
    setSystemTime();
    if (originalJwksOrigin === undefined) delete process.env.CLOUD_OAUTH_JWKS_ORIGIN;
    else process.env.CLOUD_OAUTH_JWKS_ORIGIN = originalJwksOrigin;
    if (originalIdentityOrigin === undefined) delete process.env.CLOUD_IDENTITY_JWKS_ORIGIN;
    else process.env.CLOUD_IDENTITY_JWKS_ORIGIN = originalIdentityOrigin;
    office?.stop(true);
    await gateway?.stop();
    await runtime?.stop();
  });
  for (const kind of ["agent", "standalone"] as const) {
    test(`${kind}: no grant, exact grants, path/resource/scope caps, transfers, sharing, revoke and disable`, async () => {
      const created = await serviceAccounts.createStandalone({ name: `Files ${kind}`, kind, createdBy: admin.user.id });
      if (!created.ok) throw new Error(created.error.code);
      const account = created.data;
      const credential = await token(account.id, ["admin"]);
      const readOnly = await token(account.id, ["read"]);
      const noScope = await token(account.id, ["openid"]);
      const storage = await service.createMachineStorage(call(), { ownerId: account.id, area: "cloud" });
      const base = `/bases/${storage.baseId}`;
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await request(credential.token, "/admin/machine-storage"));
      await denied(
        await request(credential.token, `/admin/machine-storage/${storage.id}/grants`, "POST", {
          principal: { type: "service_account", serviceAccountId: account.id },
          path: "",
          permission: "admin",
        }),
      );
      expect((await service.storageGrants(call(), storage.id)).items.length).toBe(0);
      const principal = { type: "service_account" as const, serviceAccountId: account.id };
      const grant = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" });
      expect((await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" })).id).toBe(grant.id);
      expect((await service.storageGrants(call(), storage.id)).items.length).toBe(1);
      const bases = await data<{ items: { id: string; owner?: { id: string } }[] }>(await request(credential.token, "/bases"));
      expect(bases.items.some((item) => item.id === storage.baseId && item.owner?.id === account.id)).toBe(true);
      await data(await request(credential.token, `${base}/entries`));
      await denied(await request(noScope.token, `${base}/entries`));
      await denied(await request(readOnly.token, `${base}/directories`, "POST", { path: "scope-denied" }));
      // All writes go through the actual Files API and its audit guard.
      await data(await request(credential.token, `${base}/directories`, "POST", { path: "allowed" }));
      const uploadId = Bun.randomUUIDv7();
      const opened = await data<{ id: string; url?: string; chunkSize: number }>(
        await request(credential.token, `${base}/uploads`, "POST", {
          idempotencyKey: uploadId,
          path: "note.txt",
          size: 3,
          onConflict: "error",
        }),
      );
      expect(Boolean(opened.url?.includes("/share/filesv2/transfer/"))).toBe(true);
      const ticket = new URL(opened.url!).pathname.replace("/share/filesv2", "");
      const segment = await publicRequest(`${ticket}?segment=0`, { method: "PUT", body: "abc" });
      expect(segment.ok).toBe(true);
      await data(await request(credential.token, `${base}/uploads/${opened.id}/commit`, "POST", {}));
      const download = await data<{ url: string }>(await request(credential.token, `${base}/download`, "POST", { path: "note.txt" }));
      const downloadPath = new URL(download.url).pathname.replace("/share/filesv2", "");
      const bytes = await publicRequest(downloadPath);
      expect(bytes.status).toBe(200);
      expect(await bytes.text()).toBe("abc");
      const otherCreated = await serviceAccounts.createStandalone({ name: `Other ${kind}`, kind, createdBy: admin.user.id });
      if (!otherCreated.ok) throw new Error(otherCreated.error.code);
      const other = await service.createMachineStorage(call(), { ownerId: otherCreated.data.id, area: "cloud" });
      await denied(await request(credential.token, `/bases/${other.baseId}/entries`));
      // A read grant cannot administer public sharing, even with an admin-scoped token.
      await service.revokeStorage(call(), storage.id, grant.id);
      const readGrant = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "read" });
      await denied(
        await request(credential.token, `${base}/shares`, "POST", {
          kind: "download",
          title: "Fixture",
          paths: ["note.txt"],
          expiresIn: "1d",
        }),
      );
      const copyLeafWrite = await service.grantStorage(call(), storage.id, { path: "note.txt", principal, permission: "write" });
      const writeToken = await token(account.id, ["write"]);
      const copyInput = { paths: ["note.txt"], targetBaseId: storage.baseId, folder: "" };
      const directory = `${prefix}/users/machine-${account.id}`;
      const beforeCopy = await client.root("cloud").list(directory);
      const deniedCopy = await data<EntriesResult>(await request(writeToken.token, `${base}/copy`, "POST", copyInput));
      expect(deniedCopy.results).toEqual([{ path: "note.txt", ok: false, error: "forbidden" }]);
      expect(deniedCopy.entries).toEqual([]);
      expect((await client.root("cloud").list(directory)).items.map((item) => item.path).sort()).toEqual(
        beforeCopy.items.map((item) => item.path).sort(),
      );
      // Parent write authority permits the intended same-folder conflict rename.
      const parentWrite = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "write" });
      const copied = await data<EntriesResult>(await request(writeToken.token, `${base}/copy`, "POST", copyInput));
      expect(copied.results).toMatchObject([{ path: "note.txt", ok: true }]);
      expect(copied.entries).toHaveLength(1);
      const sibling = copied.entries[0]!.path;
      expect(sibling).not.toBe("note.txt");
      expect(sibling.includes("/")).toBe(false);
      expect(await (await client.root("cloud").contentRaw(`${directory}/${sibling}`)).text()).toBe("abc");
      await client.root("cloud").remove(`${directory}/${sibling}`);
      expect(parentWrite.id).toBe(readGrant.id);
      await service.revokeStorage(call(), storage.id, parentWrite.id);
      await service.revokeStorage(call(), storage.id, copyLeafWrite.id);
      const adminGrant = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" });
      const actor: RequestActor = {
        kind: "service_account",
        serviceAccount: account,
        delegatedUser: null,
        scopes: ["admin"],
        credentialId: credential.credential.id,
      };
      const machineCall = testCall(actor);
      const cleanupShare = await data<{ id: string }>(
        await request(credential.token, `${base}/shares`, "POST", {
          kind: "download",
          title: "Scope fixture",
          paths: ["note.txt"],
          expiresIn: "1d",
        }),
      );
      await denied(await request(readOnly.token, `/shares/${cleanupShare.id}/revoke`, "POST", {}));
      await data(await request(credential.token, `/shares/${cleanupShare.id}/revoke`, "POST", {}));
      const share = await service.createShare(machineCall, {
        baseId: storage.baseId,
        kind: "download",
        title: "Fixture",
        paths: ["note.txt"],
        expiresIn: "1d",
      });
      const shareToken = new URL(share.url).pathname.split("/").at(-1)!;
      const publicLease = await service.publicShareDownload(shareToken, "note.txt");
      const publicPath = new URL(publicLease.url).pathname.replace("/share/filesv2", "");
      const publicBytes = await publicRequest(publicPath);
      expect(publicBytes.status).toBe(200);
      expect(await publicBytes.text()).toBe("abc");
      const archive = await service.publicShareArchive(shareToken);
      const archivePath = new URL(archive.url).pathname.replace("/share/filesv2", "");
      const archived = await publicRequest(archivePath, { method: "POST", body: new URLSearchParams({ manifest: archive.manifest }) });
      expect(archived.status).toBe(200);
      await archived.arrayBuffer();
      await service.revokeShare(machineCall, { id: share.id });
      await denied(await publicRequest(publicPath));
      await denied(await publicRequest(archivePath, { method: "POST" }));
      const inbox = await service.createShare(machineCall, {
        baseId: storage.baseId,
        kind: "inbox",
        title: "Inbox fixture",
        folder: "allowed",
        expiresIn: "1d",
      });
      const inboxToken = new URL(inbox.url).pathname.split("/").at(-1)!;
      const inboxUpload = await service.publicInboxUpload(inboxToken, { name: "visitor.txt", size: 3, idempotencyKey: Bun.randomUUIDv7() });
      const inboxPath = new URL(inboxUpload.url!).pathname.replace("/share/filesv2", "");
      expect((await publicRequest(`${inboxPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
      await service.revokeShare(machineCall, { id: inbox.id });
      await denied(await publicRequest(`${inboxPath}?segment=0`, { method: "PUT", body: "abc" }));
      await expect(service.publicInboxLease(inboxToken, inboxUpload.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.publicInboxCommit(inboxToken, inboxUpload.id)).rejects.toMatchObject({ status: 404 });
      const racingInbox = await data<{ id: string; url: string }>(
        await request(credential.token, `${base}/shares`, "POST", {
          kind: "inbox",
          title: "Publication fixture",
          folder: "allowed",
          expiresIn: "1d",
        }),
      );
      await revokedPublication(racingInbox, `${prefix}/users/machine-${account.id}/allowed`, async () =>
        data(await request(credential.token, `/shares/${racingInbox.id}/revoke`, "POST", {})),
      );
      const pending = await data<{ id: string; url: string }>(
        await request(credential.token, `${base}/uploads`, "POST", {
          idempotencyKey: Bun.randomUUIDv7(),
          path: "pending.txt",
          size: 3,
          onConflict: "error",
        }),
      );
      const pendingPath = new URL(pending.url).pathname.replace("/share/filesv2", "");
      expect((await publicRequest(`${pendingPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
      const c = await capabilityContext(credential.token);
      const providers = await fileQueries["provider.list"].run({ limit: 50 }, c);
      if (!providers.ok) throw new Error("Provider listing failed");
      expect(providers.data.data.items.some((item) => item.name === account.name)).toBe(true);
      const rootRef = await entryRef(storage.baseId, { path: "" });
      const folder = await fileQueries["provider.list"].run({ parent: rootRef, limit: 50 }, c);
      if (!folder.ok) throw new Error("Folder listing failed");
      expect(folder.data.data.writable).toBe(true);
      const saved = await fileActions["provider.save"].run({ parent: rootRef, name: "provider.txt", size: 3, mediaType: "text/plain" }, c);
      if (!saved.ok || !saved.data.stream) throw new Error("Missing provider upload stream");
      const receipt = await fileActions["provider.save"].stream.write(saved.data.stream, new Blob(["xyz"]).stream(), c);
      expect(receipt.data.file?.name).toBe("provider.txt");
      const sourceRef = await entryRef(storage.baseId, { path: "provider.txt" });
      const reading = await fileQueries["content.read"].run({ id: sourceRef }, c);
      if (!reading.ok || !reading.data.stream) throw new Error("Missing provider download stream");
      expect(await (await fileQueries["content.read"].stream.read(reading.data.stream, c)).text()).toBe("xyz");
      const template = await templateService.upload(call(), {
        name: "Machine template",
        description: "",
        filename: "template.odt",
        content: Buffer.from("template").toString("base64"),
      });
      await denied(
        await request(credential.token, `/templates/${template.id}/use`, "POST", { baseId: storage.baseId, path: "template.odt" }),
      );
      const templateGrant = await templateService.grant(call(), template.id, principal);
      await data(
        await request(credential.token, `/templates/${template.id}/use`, "POST", { baseId: storage.baseId, path: "template.odt" }),
      );
      await denied(
        await request(readOnly.token, `/templates/${template.id}/use`, "POST", { baseId: storage.baseId, path: "read-only.md" }),
      );
      const editor = await data<OfficeEditorLaunch>(await request(credential.token, `${base}/editor`, "POST", { path: "template.odt" }));
      const editorToken = editor.token;
      expect(verifyEditorToken(editorToken)?.machine?.credentialId).toBe(credential.credential.id);
      const editorRef = new URL(new URL(editor.action).searchParams.get("WOPISrc")!).pathname.split("/").at(-1)!;
      expect((await service.editorFileInfo(editorToken, editorRef, "machine-editor-fixture")).BaseFileName).toBe("template.odt");
      const readEditor = await data<OfficeEditorLaunch>(await request(readOnly.token, `${base}/editor`, "POST", { path: "template.odt" }));
      expect((await service.editorFileInfo(readEditor.token, editorRef)).UserCanWrite).toBe(false);
      await templateService.revoke(call(), template.id, templateGrant.id);
      await denied(await request(credential.token, `/templates/${template.id}`));
      await denied(
        await request(credential.token, `/templates/${template.id}/use`, "POST", { baseId: storage.baseId, path: "revoked-template.odt" }),
      );
      const revokedKey = await token(account.id, ["read"]);
      const revokeLease = await data<{ url: string }>(await request(revokedKey.token, `${base}/download`, "POST", { path: "note.txt" }));
      const revoked = await serviceAccountCredentials.revoke({ credentialId: revokedKey.credential.id, actor: admin.user });
      expect(revoked.ok).toBe(true);
      await denied(await publicRequest(new URL(revokeLease.url).pathname.replace("/share/filesv2", "")));
      const expiringKey = await token(account.id, ["read"]);
      const expiryLease = await data<{ url: string }>(await request(expiringKey.token, `${base}/download`, "POST", { path: "note.txt" }));
      await sql`UPDATE auth.service_account_credentials SET expires_at='2000-01-01T00:00:00Z' WHERE id=${expiringKey.credential.id}::uuid`;
      await denied(await publicRequest(new URL(expiryLease.url).pathname.replace("/share/filesv2", "")));
      await service.revokeStorage(call(), storage.id, adminGrant.id);
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await publicRequest(downloadPath));
      await expect(service.editorFileInfo(editorToken, editorRef, "machine-editor-fixture")).rejects.toMatchObject({ status: 404 });
      await denied(await publicRequest(pendingPath));
      await denied(await publicRequest(`${pendingPath}?segment=0`, { method: "PUT", body: "abc" }));
      await denied(await request(credential.token, `${base}/uploads/${pending.id}/lease`, "POST", {}));
      await denied(await request(credential.token, `${base}/uploads/${pending.id}/commit`, "POST", {}));
      await expect(fileQueries["content.read"].stream.read(reading.data.stream, c)).rejects.toMatchObject({ status: 404 });
      await denied(await publicRequest(`${ticket}?segment=0`, { method: "PUT", body: "abc" }));
      await denied(await request(credential.token, `${base}/uploads/${opened.id}/commit`, "POST", {}));
      const exact = await service.grantStorage(call(), storage.id, { path: "note.txt", principal, permission: "read" });
      await data(await request(credential.token, `${base}/download`, "POST", { path: "note.txt" }));
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await request(credential.token, `${base}/download`, "POST", { path: "note.txt-other" }));
      await service.revokeStorage(call(), storage.id, exact.id);
      const fileAdmin = await service.grantStorage(call(), storage.id, { path: "note.txt", principal, permission: "admin" });
      const fileShare = await service.createShare(machineCall, {
        baseId: storage.baseId,
        kind: "download",
        title: "One file",
        paths: ["note.txt"],
        expiresIn: "1d",
      });
      expect(fileShare.createdByKind).toBe(kind);
      const fileShareToken = new URL(fileShare.url).pathname.split("/").at(-1)!;
      expect((await service.publicShare(fileShareToken, "download")).items.map((item) => item.name)).toEqual(["note.txt"]);
      await service.publicShareDownload(fileShareToken, "note.txt");
      await service.revokeStorage(call(), storage.id, fileAdmin.id);
      await denied(await request(readOnly.token, `/shares/${fileShare.id}/revoke`, "POST", {}));
      await data(await request(credential.token, `/shares/${fileShare.id}/revoke`, "POST", {}));
      await expect(service.publicShareDownload(fileShareToken, "note.txt")).rejects.toMatchObject({ status: 404 });
      const leafWrite = await service.grantStorage(call(), storage.id, { path: "leaf.txt", principal, permission: "write" });
      const leaf = await data<{ id: string; url: string }>(
        await request(credential.token, `${base}/uploads`, "POST", {
          idempotencyKey: Bun.randomUUIDv7(),
          path: "leaf.txt",
          size: 3,
          onConflict: "error",
        }),
      );
      expect(
        (await publicRequest(`${new URL(leaf.url).pathname.replace("/share/filesv2", "")}?segment=0`, { method: "PUT", body: "abc" }))
          .status,
      ).toBe(200);
      await data(await request(credential.token, `${base}/uploads/${leaf.id}/commit`, "POST", {}));
      await denied(await request(credential.token, `${base}/entries`));
      const removed = await service.remove(machineCall, { baseId: storage.baseId, paths: ["leaf.txt"] });
      const removedItem = removed.results[0];
      if (!removedItem?.ok) throw new Error(removedItem?.error ?? "Missing trash result");
      expect((await service.trash(machineCall, { baseId: storage.baseId })).entries.map((item) => item.name)).toEqual(["leaf.txt"]);
      expect((await service.restoreTrash(machineCall, { baseId: storage.baseId, id: removedItem.entry.id })).entry.path).toBe("leaf.txt");
      await service.revokeStorage(call(), storage.id, leafWrite.id);
      const active = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" });
      const liveLease = await service.download(machineCall, { baseId: storage.baseId, path: "note.txt" });
      const liveShare = await service.createShare(machineCall, {
        baseId: storage.baseId,
        kind: "download",
        title: "Live account fixture",
        paths: ["note.txt"],
        expiresIn: "1d",
      });
      const liveShareToken = new URL(liveShare.url).pathname.split("/").at(-1)!;
      const livePublicLease = await service.publicShareDownload(liveShareToken, "note.txt");
      // Human grantees receive the same revocable transfer boundary for machine-owned storage.
      const humanGrant = await service.grantStorage(call(), storage.id, {
        path: "note.txt",
        principal: { type: "user", userId: admin.user.id },
        permission: "read",
      });
      // Linux identity provisioning stays disabled: a human grant also uses the storage's service identity.
      expect((await service.bases(call())).items.some((item) => item.id === storage.baseId)).toBe(true);
      const humanLease = await service.download(call(), { baseId: storage.baseId, path: "note.txt" });
      const humanBytes = await publicRequest(new URL(humanLease.url).pathname.replace("/share/filesv2", ""));
      expect(await humanBytes.text()).toBe("abc");
      const personalKey = await serviceAccountCredentials.createApiToken({
        serviceAccountId: personalAccountId,
        name: `Personal ${kind} fixture`,
        scopes: [],
      });
      if (!personalKey.ok) throw new Error("Delegated fixture key failed");
      const personalLease = await data<{ url: string }>(
        await request(personalKey.data.token, `${base}/download`, "POST", { path: "note.txt" }),
      );
      const personalBytes = await publicRequest(new URL(personalLease.url).pathname.replace("/share/filesv2", ""));
      expect(await personalBytes.text()).toBe("abc");
      const humanTemplateGrant = await service.grantStorage(call(), storage.id, {
        path: "template.odt",
        principal: { type: "user", userId: admin.user.id },
        permission: "read",
      });
      const personalEditor = await data<OfficeEditorLaunch>(
        await request(personalKey.data.token, `${base}/editor`, "POST", { path: "template.odt" }),
      );
      expect(verifyEditorToken(personalEditor.token)?.userId).toBe(personalAccountId);
      const personalInfo = await service.editorFileInfo(personalEditor.token, editorRef);
      expect(personalInfo.UserCanWrite).toBe(false);
      expect(personalInfo.UserId).toBe(admin.user.id);
      expect((await serviceAccountCredentials.revoke({ credentialId: personalKey.data.credential.id, actor: admin.user })).ok).toBe(true);
      await denied(await publicRequest(new URL(personalLease.url).pathname.replace("/share/filesv2", "")));
      await expect(service.editorFileInfo(personalEditor.token, editorRef)).rejects.toMatchObject({ status: 403 });
      await service.revokeStorage(call(), storage.id, humanTemplateGrant.id);
      await service.revokeStorage(call(), storage.id, humanGrant.id);
      await denied(await publicRequest(new URL(humanLease.url).pathname.replace("/share/filesv2", "")));
      await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${account.id}::uuid`;
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await publicRequest(new URL(liveLease.url).pathname.replace("/share/filesv2", "")));
      await denied(await publicRequest(new URL(livePublicLease.url).pathname.replace("/share/filesv2", "")));
      await expect(service.publicShareDownload(liveShareToken, "note.txt")).rejects.toMatchObject({ status: 404 });
      await expect(service.download(machineCall, { baseId: storage.baseId, path: "note.txt" })).rejects.toMatchObject({ status: 403 });
      await expect(service.editorFileInfo(editorToken, editorRef, "machine-editor-fixture")).rejects.toMatchObject({ status: 403 });
      await service.revokeStorage(call(), storage.id, active.id);
      const [audit] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM filesv2.activity WHERE actor_service_account_id=${account.id}::uuid`;
      expect(audit!.count).toBeGreaterThan(0);
      const [accessAudit] = await sql<
        { request_id: string; metadata: { principalId: string; pathHash: string }; outcome: string }[]
      >`SELECT request_id,metadata,outcome FROM audit.events WHERE action='files.storage.read' AND target_id=${storage.id} AND request_id='machine-files-fixture' AND metadata->>'principalId'=${account.id} ORDER BY id DESC LIMIT 1`;
      expect(accessAudit?.request_id).toBe("machine-files-fixture");
      expect(accessAudit?.metadata.principalId).toBe(account.id);
      expect(accessAudit?.metadata.pathHash).toMatch(/^[a-f0-9]{64}$/);
      const [misattributed] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM filesv2.activity WHERE actor_service_account_id=${account.id}::uuid AND (actor_user_id IS NOT NULL OR actor_kind<>'service_account')`;
      expect(misattributed!.count).toBe(0);
      expect((await serviceAccounts.delete({ id: account.id })).ok).toBe(true);
      const retained = (await service.machineStorage(call())).items.find((item) => item.id === storage.id);
      expect(retained?.owner).toEqual({ id: account.id, name: account.name, kind });
      expect((await service.listShares(call(), { admin: true })).items.find((item) => item.id === liveShare.id)?.createdByKind).toBe(kind);
      await denied(await publicRequest(new URL(liveLease.url).pathname.replace("/share/filesv2", "")));
      await expect(service.createMachineStorage(call(), { ownerId: otherCreated.data.id, area: "freeipa" })).rejects.toMatchObject({
        code: "identity_incomplete",
      });
    }, 60000);
  }
  for (const delegated of [false, true]) {
    test(`${delegated ? "personal delegated" : "human"}: publication guard and owner cleanup survive storage grant removal`, async () => {
      const owner = await serviceAccounts.createStandalone({
        name: `${delegated ? "Delegated" : "Human"} share storage`,
        kind: "standalone",
        createdBy: admin.user.id,
      });
      if (!owner.ok) throw new Error(owner.error.code);
      const storage = await service.createMachineStorage(call(), { ownerId: owner.data.id, area: "cloud" });
      const grant = await service.grantStorage(call(), storage.id, {
        path: "",
        principal: { type: "user", userId: admin.user.id },
        permission: "admin",
      });
      let personal: string | null = null;
      if (delegated) {
        const credential = await serviceAccountCredentials.createApiToken({
          serviceAccountId: personalAccountId,
          name: "Personal share cleanup",
          scopes: [],
        });
        if (!credential.ok) throw new Error(credential.error.code);
        personal = credential.data.token;
      }
      const create = async () => {
        const input = { kind: "inbox" as const, title: "Human publication fixture", folder: "", expiresIn: "1d" as const };
        return personal
          ? data<{ id: string; url: string }>(await request(personal, `/bases/${storage.baseId}/shares`, "POST", input))
          : service.createShare(call(), { ...input, baseId: storage.baseId });
      };
      const revoke = async (id: string) =>
        personal ? data(await request(personal, `/shares/${id}/revoke`, "POST", {})) : service.revokeShare(call(), { id });
      const racing = await create();
      await revokedPublication(racing, `${prefix}/users/machine-${owner.data.id}`, () => revoke(racing.id));
      const cleanup = await create();
      await service.revokeStorage(call(), storage.id, grant.id);
      await revoke(cleanup.id);
    }, 60000);
  }
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: signed OAuth authority survives in transfers and editors only while its client is live`, async () => {
      const created = await serviceAccounts.createStandalone({ name: `OAuth Files ${kind}`, kind, createdBy: admin.user.id });
      if (!created.ok) throw new Error(created.error.code);
      const account = created.data;
      const storage = await service.createMachineStorage(call(), { ownerId: account.id, area: "cloud" });
      const principal = { type: "service_account" as const, serviceAccountId: account.id };
      const grant = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" });
      const clientId = `files-oauth-${Bun.randomUUIDv7()}`;
      await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,service_account_id,scopes) VALUES(${`Files ${kind} fixture`},${clientId},ARRAY[]::text[],${account.id}::uuid,ARRAY['read','write','admin'])`;
      const sign = (scope: string, expires: number) =>
        new SignJWT({
          token_use: "access",
          client_id: clientId,
          service_account_id: account.id,
          scope,
        })
          .setProtectedHeader({ alg: "RS256", kid: oauthKid })
          .setIssuer("http://files-machine.test")
          .setSubject(account.id)
          .setAudience("cloud")
          .setIssuedAt(Math.floor(Date.now() / 1000))
          .setExpirationTime(expires)
          .sign(oauthPrivateKey);
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const bearer = await sign("admin", expiry);
      const readBearer = await sign("read", expiry);
      const base = `/bases/${storage.baseId}`;
      const captureResponse = await capture.request("/", { headers: { authorization: `Bearer ${bearer}` } });
      const identity = await data<{ actor: RequestActor; authority: RequestAuthority }>(captureResponse);
      expect(identity.actor).toMatchObject({ kind: "service_account", credentialId: null, oauthClientId: clientId });
      const upload = await data<{ id: string; url: string }>(
        await request(bearer, `${base}/uploads`, "POST", {
          idempotencyKey: Bun.randomUUIDv7(),
          path: "oauth.odt",
          size: 3,
          onConflict: "error",
        }),
      );
      const uploadPath = new URL(upload.url).pathname.replace("/share/filesv2", "");
      expect((await publicRequest(`${uploadPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
      await data(await request(bearer, `${base}/uploads/${upload.id}/commit`, "POST", {}));
      const download = await data<{ url: string }>(await request(bearer, `${base}/download`, "POST", { path: "oauth.odt" }));
      const transferPath = new URL(download.url).pathname.replace("/share/filesv2", "");
      expect(await (await publicRequest(transferPath)).text()).toBe("abc");
      const editor = await data<OfficeEditorLaunch>(await request(bearer, `${base}/editor`, "POST", { path: "oauth.odt" }));
      const ref = new URL(new URL(editor.action).searchParams.get("WOPISrc")!).pathname.split("/").at(-1)!;
      expect(verifyEditorToken(editor.token)?.machine).toMatchObject({
        oauthClientId: clientId,
        credentialExpiresAt: new Date(expiry * 1000).toISOString(),
        scopes: ["admin"],
      });
      expect((await service.editorFileInfo(editor.token, ref)).UserCanWrite).toBe(true);
      expect(await service.editorSave(editor.token, ref, { timestamp: null, read: async () => new Blob(["abc"]) })).toHaveProperty(
        "modified",
      );
      const readEditor = await data<OfficeEditorLaunch>(await request(readBearer, `${base}/editor`, "POST", { path: "oauth.odt" }));
      expect((await service.editorFileInfo(readEditor.token, ref)).UserCanWrite).toBe(false);
      await expect(
        service.editorSave(readEditor.token, ref, { timestamp: null, read: async () => new Blob(["denied"]) }),
      ).rejects.toMatchObject({ status: 403 });
      await denied(await request(readBearer, `${base}/directories`, "POST", { path: "scope-denied" }));
      await denied(await request(await sign("admin", Math.floor(Date.now() / 1000) - 1), `${base}/entries`));
      const originalTime = Date.now();
      const shortBearer = await sign("read", Math.floor(originalTime / 1000) + 1);
      const shortTransfer = await data<{ url: string }>(await request(shortBearer, `${base}/download`, "POST", { path: "oauth.odt" }));
      const shortEditor = await data<OfficeEditorLaunch>(await request(shortBearer, `${base}/editor`, "POST", { path: "oauth.odt" }));
      try {
        setSystemTime(originalTime + 2000);
        await denied(await publicRequest(new URL(shortTransfer.url).pathname.replace("/share/filesv2", "")));
        await expect(service.editorFileInfo(shortEditor.token, ref)).rejects.toMatchObject({ status: 403 });
      } finally {
        setSystemTime(originalTime);
      }
      // Only safe identity references are retained; upstream lease material stays encrypted.
      const [ticket] = await sql<
        { oauth_client_id: string; payload: string; scopes: string[] }[]
      >`SELECT oauth_client_id,payload,scopes FROM filesv2.transfer_tickets WHERE base_id=${storage.id}::uuid AND permission='read' AND scopes=ARRAY['admin']::text[] ORDER BY expires_at DESC LIMIT 1`;
      expect(ticket?.oauth_client_id).toBe(clientId);
      expect(ticket?.scopes).toEqual(["admin"]);
      expect(JSON.stringify(ticket)).not.toContain(bearer);
      expect(Buffer.from(editor.token.split(".")[0]!, "base64url").toString()).not.toContain(bearer);
      const invocationInput = {
        issuer: "http://files-machine.test",
        callingAppId: "core",
        targetAppId: "filesv2",
        operation: "capability.query:content.read",
        schemaHash: null,
        authority: invocationAuthorityFromRequest(identity.authority),
        signer: { key: oauthPrivateKey, kid: oauthKid, signUntil: new Date(expiry * 1000) },
      };
      const signedInvocation = await issueInvocationToken(invocationInput);
      const invocationEndpoint = new Hono<AuthContext>()
        .use(requireInvocation(() => ({ targetAppId: "filesv2", operation: "capability.query:content.read", schemaHash: null })))
        .get("/", (c) => c.json({ actor: c.get("actor") }));
      const invoke = () => invocationEndpoint.request("/", { headers: { authorization: `Bearer ${signedInvocation.token}` } });
      const transported = await data<{ actor: RequestActor }>(await invoke());
      expect(transported.actor).toMatchObject({ oauthClientId: clientId, scopes: ["admin"] });
      const invocationCall = testCall(transported.actor);
      const invocationDownload = await service.download(invocationCall, { baseId: storage.baseId, path: "oauth.odt" });
      const invocationPath = new URL(invocationDownload.url).pathname.replace("/share/filesv2", "");
      expect(await (await publicRequest(invocationPath)).text()).toBe("abc");
      const invocationEditor = await service.editor(invocationCall, { baseId: storage.baseId, path: "oauth.odt" });
      if (invocationEditor.kind === "markdown") throw new Error("Expected office editor");
      expect((await service.editorFileInfo(invocationEditor.token, ref)).UserCanWrite).toBe(true);
      // Issuance revalidation uses the caller's transaction, including its live client view.
      const rollback = new Error("Rollback OAuth authority fixture");
      await expect(
        sql.begin(async (tx) => {
          await tx`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
          await expect(issueInvocationToken(invocationInput, { db: tx })).rejects.toMatchObject({ code: "app_access_denied" });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await data(await invoke());
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      expect((await serviceAccounts.get({ id: account.id }))?.status).toBe("active");
      expect((await service.storageGrants(call(), storage.id)).items.some((item) => item.id === grant.id)).toBe(true);
      await expect(issueInvocationToken(invocationInput)).rejects.toMatchObject({ code: "app_access_denied" });
      await denied(await invoke());
      await denied(await publicRequest(invocationPath));
      await expect(service.editorFileInfo(invocationEditor.token, ref)).rejects.toMatchObject({ status: 403 });
      await denied(await request(bearer, `${base}/entries`));
      await denied(await publicRequest(transferPath));
      await denied(await publicRequest(`${uploadPath}?segment=0`, { method: "PUT", body: "abc" }));
      await expect(service.editorFileInfo(editor.token, ref)).rejects.toMatchObject({ status: 403 });
      await expect(service.editorContent(editor.token, ref)).rejects.toMatchObject({ status: 403 });
      await expect(
        service.editorSave(editor.token, ref, { timestamp: null, read: async () => new Blob(["denied"]) }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(service.editorFileInfo(readEditor.token, ref)).rejects.toMatchObject({ status: 403 });
    }, 60000);
  }
});
