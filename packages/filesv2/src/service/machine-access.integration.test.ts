import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProcessSync, startProcessSync } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { type AccessSubject, type AuthContext, auth, type RequestActor } from "@k2b/cloud/server";
import { accounts, coreSettings, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { Filegate } from "@k2b/filegate";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { activityFilegate } from "../../test/activity-filegate";
import { testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import api from "../api";
import type { OfficeEditorLaunch } from "../contracts";
import { entryRef } from "../data/references";
import { fileActions, fileQueries } from "../file-capabilities";
import { migrate } from "../migrate";
import { publicApi } from "../public";
import { filesService as service } from ".";
import { verifyEditorToken } from "./collabora";
import { templateService } from "./templates";

const suite = suiteFor("database", "nats", "valkey");
suite("Files machine storage through actual API tokens", () => {
  let runtime: ProcessSync | undefined;
  let gateway: Awaited<ReturnType<typeof activityFilegate>> | undefined;
  let admin: Extract<RequestActor, { kind: "user" }>;
  let client: Filegate;
  let office: ReturnType<typeof Bun.serve> | undefined;
  const prefix = `machine-access-${Bun.randomUUIDv7()}`;
  const call = () => testCall(admin);
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
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": "machine-files-fixture" },
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
    .get("/", (c) => c.json({ actor: c.get("actor"), subject: c.get("accessSubject") }));
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
  beforeAll(async () => {
    await assertPrivateDatabase();
    // Use real Core schemas and public services; no stand-in authentication or grant resolver.
    for (const name of ["auth", "settings", "audit"]) {
      const path = `../../../core/src/migrate/core/${name}.ts`;
      const module = await import(path);
      await module.migrate();
    }
    await migrate();
    const adminId = Bun.randomUUIDv7();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name) VALUES(${adminId}::uuid,'files-machine-admin','local','user',true,'Fixture administrator')`;
    const user = await accounts.users.get({ id: adminId });
    if (!user) throw new Error("Missing administrator");
    admin = { kind: "user", user };
    await coreSettings.set("app.url", "http://files-machine.test");
    runtime = await startProcessSync({ application: "filesv2" });
    gateway = await activityFilegate();
    client = new Filegate({ baseUrl: gateway.url, token: gateway.token, transferBaseUrl: gateway.url });
    await client.root("cloud").mkdir(prefix, { ownership: { dirMode: "0700" } });
    office = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<wopi-discovery><net-zone name="external-http"><app name="writer"><action ext="odt" name="edit" urlsrc="https://office.example.test/browser/editor?"/><action ext="odt" name="view" urlsrc="https://office.example.test/browser/editor?"/></app></net-zone></wopi-discovery>`,
        ),
    });
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
      const segment = await publicApi.request(`${ticket}?segment=0`, { method: "PUT", body: "abc" });
      expect(segment.ok).toBe(true);
      await data(await request(credential.token, `${base}/uploads/${opened.id}/commit`, "POST", {}));
      const download = await data<{ url: string }>(await request(credential.token, `${base}/download`, "POST", { path: "note.txt" }));
      const downloadPath = new URL(download.url).pathname.replace("/share/filesv2", "");
      const bytes = await publicApi.request(downloadPath);
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
      await service.revokeStorage(call(), storage.id, readGrant.id);
      const adminGrant = await service.grantStorage(call(), storage.id, { path: "", principal, permission: "admin" });
      const actor: RequestActor = {
        kind: "service_account",
        serviceAccount: account,
        delegatedUser: null,
        scopes: ["admin"],
        credentialId: credential.credential.id,
      };
      const machineCall = testCall(actor);
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
      const publicBytes = await publicApi.request(publicPath);
      expect(publicBytes.status).toBe(200);
      expect(await publicBytes.text()).toBe("abc");
      const archive = await service.publicShareArchive(shareToken);
      const archivePath = new URL(archive.url).pathname.replace("/share/filesv2", "");
      const archived = await publicApi.request(archivePath, { method: "POST", body: new URLSearchParams({ manifest: archive.manifest }) });
      expect(archived.status).toBe(200);
      await archived.arrayBuffer();
      await service.revokeShare(machineCall, { id: share.id });
      await denied(await publicApi.request(publicPath));
      await denied(await publicApi.request(archivePath, { method: "POST" }));
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
      expect((await publicApi.request(`${inboxPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
      await service.revokeShare(machineCall, { id: inbox.id });
      await denied(await publicApi.request(`${inboxPath}?segment=0`, { method: "PUT", body: "abc" }));
      await expect(service.publicInboxLease(inboxToken, inboxUpload.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.publicInboxCommit(inboxToken, inboxUpload.id)).rejects.toMatchObject({ status: 404 });
      const pending = await data<{ id: string; url: string }>(
        await request(credential.token, `${base}/uploads`, "POST", {
          idempotencyKey: Bun.randomUUIDv7(),
          path: "pending.txt",
          size: 3,
          onConflict: "error",
        }),
      );
      const pendingPath = new URL(pending.url).pathname.replace("/share/filesv2", "");
      expect((await publicApi.request(`${pendingPath}?segment=0`, { method: "PUT", body: "abc" })).status).toBe(200);
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
      await denied(await publicApi.request(new URL(revokeLease.url).pathname.replace("/share/filesv2", "")));
      const expiringKey = await token(account.id, ["read"]);
      const expiryLease = await data<{ url: string }>(await request(expiringKey.token, `${base}/download`, "POST", { path: "note.txt" }));
      await sql`UPDATE auth.service_account_credentials SET expires_at='2000-01-01T00:00:00Z' WHERE id=${expiringKey.credential.id}::uuid`;
      await denied(await publicApi.request(new URL(expiryLease.url).pathname.replace("/share/filesv2", "")));
      await service.revokeStorage(call(), storage.id, adminGrant.id);
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await publicApi.request(downloadPath));
      await expect(service.editorFileInfo(editorToken, editorRef, "machine-editor-fixture")).rejects.toMatchObject({ status: 404 });
      await denied(await publicApi.request(pendingPath));
      await denied(await publicApi.request(`${pendingPath}?segment=0`, { method: "PUT", body: "abc" }));
      await denied(await request(credential.token, `${base}/uploads/${pending.id}/lease`, "POST", {}));
      await denied(await request(credential.token, `${base}/uploads/${pending.id}/commit`, "POST", {}));
      await expect(fileQueries["content.read"].stream.read(reading.data.stream, c)).rejects.toMatchObject({ status: 404 });
      await denied(await publicApi.request(`${ticket}?segment=0`, { method: "PUT", body: "abc" }));
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
        (await publicApi.request(`${new URL(leaf.url).pathname.replace("/share/filesv2", "")}?segment=0`, { method: "PUT", body: "abc" }))
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
      const humanBytes = await publicApi.request(new URL(humanLease.url).pathname.replace("/share/filesv2", ""));
      expect(await humanBytes.text()).toBe("abc");
      const delegated = await serviceAccounts.createUserDelegated({ name: "Personal Files fixture", delegatedUserId: admin.user.id });
      if (!delegated.ok) throw new Error("Delegated fixture account failed");
      const personalKey = await serviceAccountCredentials.createApiToken({
        serviceAccountId: delegated.data.id,
        name: "Personal fixture",
        scopes: [],
      });
      if (!personalKey.ok) throw new Error("Delegated fixture key failed");
      const personalLease = await data<{ url: string }>(
        await request(personalKey.data.token, `${base}/download`, "POST", { path: "note.txt" }),
      );
      const personalBytes = await publicApi.request(new URL(personalLease.url).pathname.replace("/share/filesv2", ""));
      expect(await personalBytes.text()).toBe("abc");
      const humanTemplateGrant = await service.grantStorage(call(), storage.id, {
        path: "template.odt",
        principal: { type: "user", userId: admin.user.id },
        permission: "read",
      });
      const personalEditor = await data<OfficeEditorLaunch>(
        await request(personalKey.data.token, `${base}/editor`, "POST", { path: "template.odt" }),
      );
      expect(verifyEditorToken(personalEditor.token)?.userId).toBe(delegated.data.id);
      const personalInfo = await service.editorFileInfo(personalEditor.token, editorRef);
      expect(personalInfo.UserCanWrite).toBe(false);
      expect(personalInfo.UserId).toBe(admin.user.id);
      expect((await serviceAccountCredentials.revoke({ credentialId: personalKey.data.credential.id, actor: admin.user })).ok).toBe(true);
      await denied(await publicApi.request(new URL(personalLease.url).pathname.replace("/share/filesv2", "")));
      await expect(service.editorFileInfo(personalEditor.token, editorRef)).rejects.toMatchObject({ status: 403 });
      await service.revokeStorage(call(), storage.id, humanTemplateGrant.id);
      await service.revokeStorage(call(), storage.id, humanGrant.id);
      await denied(await publicApi.request(new URL(humanLease.url).pathname.replace("/share/filesv2", "")));
      await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${account.id}::uuid`;
      await denied(await request(credential.token, `${base}/entries`));
      await denied(await publicApi.request(new URL(liveLease.url).pathname.replace("/share/filesv2", "")));
      await denied(await publicApi.request(new URL(livePublicLease.url).pathname.replace("/share/filesv2", "")));
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
      await denied(await publicApi.request(new URL(liveLease.url).pathname.replace("/share/filesv2", "")));
      await expect(service.createMachineStorage(call(), { ownerId: otherCreated.data.id, area: "freeipa" })).rejects.toMatchObject({
        code: "identity_incomplete",
      });
    }, 60000);
  }
});
