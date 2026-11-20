import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { discoverJmapFolders, type JmapRemoteFolder, verifyJmap } from "./jmap";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_MAIL,
  type JmapAccess,
  JmapError,
  JmapHttpError,
  type JmapSession,
  jmapBasicAuthorization,
  jmapCoreLimitsSchema,
  jmapIdSchema,
} from "./jmap-client";
import type { JmapTransportDependencies } from "./jmap-transport";

// Assertions print only their stage, never server bodies, credentials or tokens.
function check(condition: unknown, stage: string): asserts condition {
  ok(condition, stage);
}
async function stage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error instanceof JmapError ? ` (${error.code})` : "";
    throw new Error(`${label}: request failed${code}`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}
function folderById(folders: JmapRemoteFolder[], id: string, label: string): JmapRemoteFolder {
  const folder = folders.find((entry) => entry.mailboxId === id);
  check(folder, `${label}: mailbox found by id`);
  return folder;
}

const setSchema = z.object({
  created: z.record(z.string(), z.object({ id: jmapIdSchema })).nullish(),
  notCreated: z.record(z.string(), z.object({ type: z.string(), properties: z.array(z.string()).optional() })).nullish(),
  updated: z.record(z.string(), z.unknown()).nullish(),
  destroyed: z.array(jmapIdSchema).nullish(),
});

suiteFor("jmap")("Mail connector conformance against CI Stalwart", () => {
  const origin = "https://stalwart.example.invalid";
  let authorization: string;
  let wrongAuthorization: string;
  let dependencies: JmapTransportDependencies;

  beforeAll(() => {
    let target: URL;
    let username: string;
    let password: string;
    try {
      target = new URL(requireInfraUrl("jmap"));
      username = decodeURIComponent(target.username);
      password = decodeURIComponent(target.password);
    } catch {
      throw new Error("Setup: invalid JMAP infrastructure URL");
    }
    check(target.protocol === "http:" && target.hostname === "127.0.0.1", "Setup: expected CI HTTP loopback endpoint");
    check(username.length > 0 && password.length > 0, "Setup: credentials required");
    authorization = jmapBasicAuthorization(username, { kind: "password", password });
    wrongAuthorization = jmapBasicAuthorization(username, { kind: "password", password: `${password}-incorrect` });
    const hostname = target.hostname;
    const port = Number(target.port || 80);
    // Only the socket destination changes. Redirects, response bodies and HTTPS
    // validation remain production behavior, including relative Session URLs.
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
  });

  const access = (signal: AbortSignal): JmapAccess => ({ origin, authorization, signal });
  const method = async (
    session: JmapSession,
    accountId: string,
    signal: AbortSignal,
    label: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const response = await stage(label, () =>
      callJmap(
        { session, authorization, signal, using: [JMAP_CORE, JMAP_MAIL], methodCalls: [[name, { accountId, ...args }, "conformance"]] },
        dependencies,
      ),
    );
    const result = response.methodResponses[0];
    check(response.methodResponses.length === 1 && result?.[0] === name && result[2] === "conformance", `${label}: method response`);
    check(result[1].accountId === accountId, `${label}: account identity`);
    return result[1];
  };

  test("verifyJmap returns the primary mail account and Core limits", async () => {
    const input = access(AbortSignal.timeout(10_000));
    const session = await stage("Session baseline", () => fetchJmapSession(input, dependencies));
    const verified = await stage("Verify", () => verifyJmap(input, dependencies));
    check(jmapIdSchema.safeParse(verified.accountId).success, "Verify: valid account id");
    check(verified.accountId === session.primaryAccounts[JMAP_MAIL], "Verify: primary mail account");
    check(session.accounts[verified.accountId]?.accountCapabilities[JMAP_MAIL], "Verify: account supports mail");
    check(verified.origin === origin, "Verify: fictional HTTPS origin preserved");
    check(jmapCoreLimitsSchema.safeParse(verified.limits).success, "Verify: valid Core limits");
    for (const key of jmapCoreLimitsSchema.keyof().options) {
      check(JSON.stringify(verified.limits[key]) === JSON.stringify(session.core[key]), `Verify: Core ${key}`);
    }
    check(verified.limits.maxCallsInRequest === 16, "Verify: measured call limit");
    check(verified.limits.maxObjectsInGet === 500 && verified.limits.maxObjectsInSet === 500, "Verify: measured object limits");
    check(verified.limits.maxConcurrentRequests === 4, "Verify: measured request concurrency");
  }, 30_000);

  test("discovery preserves standard roles, rights, unique ids and stable keys", async () => {
    const input = access(AbortSignal.timeout(10_000));
    const folders = await stage("Discovery first", () => discoverJmapFolders(input, dependencies));
    check(new Set(folders.map((folder) => folder.mailboxId)).size === folders.length, "Discovery first: unique mailbox ids");
    for (const role of ["inbox", "drafts", "sent", "trash", "junk"]) {
      const folder = folders.find((entry) => entry.role === role);
      check(folder, `Discovery roles: ${role} present`);
      check(folder.parentMailboxId === null, `Discovery roles: ${role} is a root`);
    }
    const inbox = folders.find((folder) => folder.role === "inbox");
    check(inbox, "Discovery rights: Inbox present");
    for (const right of ["read", "write_flags", "insert"]) check(inbox.rights.includes(right), `Discovery rights: ${right}`);
    const session = await stage("Rights baseline Session", () => fetchJmapSession(input, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, "Rights baseline: primary account");
    const raw = await method(session, accountId, input.signal, "Rights baseline", "Mailbox/get", {
      ids: [inbox.mailboxId],
      properties: ["id", "myRights"],
    });
    const rights = parse(
      z.object({ list: z.array(z.object({ id: jmapIdSchema, myRights: z.record(z.string(), z.boolean()) })) }),
      raw,
      "Rights baseline",
    );
    check(rights.list.length === 1 && rights.list[0]?.id === inbox.mailboxId, "Rights baseline: Inbox identity");
    check(typeof rights.list[0]?.myRights.mayShare === "boolean", "Rights baseline: extra mayShare accepted by discovery");
    check(typeof rights.list[0]?.myRights.maySetMetadata === "boolean", "Rights baseline: extra maySetMetadata accepted by discovery");
    const again = await stage("Discovery second", () => discoverJmapFolders(input, dependencies));
    check(new Set(again.map((folder) => folder.mailboxId)).size === again.length, "Discovery second: unique mailbox ids");
    for (const folder of folders) {
      const repeated = folderById(again, folder.mailboxId, "Discovery second");
      check(folder.stableKey.length > 0 && repeated.stableKey === folder.stableKey, "Discovery second: stable mailbox key");
    }
  }, 30_000);

  test("discovers created hierarchy and preserves identity after parent rename", async () => {
    const input = access(AbortSignal.timeout(20_000));
    const session = await stage("Hierarchy Session", () => fetchJmapSession(input, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, "Hierarchy: primary account");
    const suffix = `${process.pid}-${process.hrtime.bigint()}`;
    const parentName = `Example-${suffix}`;
    const renamedName = `Renamed-${suffix}`;
    const otherName = `Other-${suffix}`;
    const slashName = `Child-${suffix}/Example`;
    const plainName = `Child-${suffix}`;
    const ownedNames = new Set([parentName, renamedName, otherName, slashName, plainName]);
    const createdIds = new Set<string>();
    const set = async (label: string, args: Record<string, unknown>, signal = input.signal) =>
      parse(setSchema, await method(session, accountId, signal, label, "Mailbox/set", args), label);
    const create = async (name: string, parentId: string | null, label: string, allowNameRejection = false) => {
      const result = await set(label, { create: { fixture: { name, parentId } } });
      const created = result.created?.fixture;
      if (created) {
        createdIds.add(created.id);
        return created.id;
      }
      const error = result.notCreated?.fixture;
      check(
        allowNameRejection && error?.type === "invalidProperties" && (!error.properties || error.properties.includes("name")),
        `${label}: creation succeeded or slash name rejected`,
      );
      return null;
    };
    try {
      const parentId = await create(parentName, null, "Create parent");
      check(parentId, "Create parent: id");
      let childName = slashName;
      let childId = await create(childName, parentId, "Create slash child", true);
      let otherParentId: string | null = null;
      let otherChildId: string | null = null;
      if (childId === null) {
        // RFC 8621 §2 permits rejecting '/'; equal names under distinct parents
        // still demonstrate why parent identity cannot be inferred from names.
        childName = plainName;
        childId = await create(childName, parentId, "Create plain child");
        otherParentId = await create(otherName, null, "Create other parent");
        check(otherParentId, "Create other parent: id");
        otherChildId = await create(childName, otherParentId, "Create same-name child");
        check(otherChildId, "Create same-name child: id");
      }
      check(childId, "Create child: id");
      const before = await stage("Hierarchy discovery", () => discoverJmapFolders(input, dependencies));
      const parent = folderById(before, parentId, "Hierarchy parent");
      const child = folderById(before, childId, "Hierarchy child");
      check(parent.path === parentName && parent.parentMailboxId === null, "Hierarchy parent: root path");
      check(child.name === childName && child.path === `${parentName}/${childName}`, "Hierarchy child: literal name and path");
      check(child.parentMailboxId === parentId && child.parentPath === parentName, "Hierarchy child: parent identity and path");
      check(child.stableKey !== parent.stableKey, "Hierarchy: distinct stable keys");
      if (otherChildId && otherParentId) {
        const other = folderById(before, otherChildId, "Hierarchy same-name child");
        check(other.name === child.name && other.parentMailboxId === otherParentId, "Hierarchy same-name child: distinct parent");
        check(other.path === `${otherName}/${childName}` && other.parentPath === otherName, "Hierarchy same-name child: path");
        check(other.mailboxId !== child.mailboxId && other.stableKey !== child.stableKey, "Hierarchy same-name child: distinct identity");
      }
      const renamed = await set("Rename parent", { update: { [parentId]: { name: renamedName } } });
      check(renamed.updated && Object.hasOwn(renamed.updated, parentId), "Rename parent: update acknowledged");
      const after = await stage("Rename discovery", () => discoverJmapFolders(input, dependencies));
      const newParent = folderById(after, parentId, "Rename parent");
      const newChild = folderById(after, childId, "Rename child");
      check(newParent.stableKey === parent.stableKey && newParent.path === renamedName, "Rename parent: stable identity, new path");
      check(newParent.name === renamedName && newParent.parentMailboxId === null, "Rename parent: name and root identity");
      check(newChild.stableKey === child.stableKey && newChild.parentMailboxId === parentId, "Rename child: stable identity and parent");
      check(newChild.path === `${renamedName}/${childName}` && newChild.parentPath === renamedName, "Rename child: new path");
    } finally {
      // Raw reads keep cleanup independent of discovery assertions and recover
      // a successful create/rename whose response was lost. Delete children first
      // (RFC 8621 §2.5); never remove messages or touch standard mailboxes.
      const signal = AbortSignal.timeout(5_000);
      const result = await method(session, accountId, signal, "Cleanup inventory", "Mailbox/get", {
        ids: null,
        properties: ["id", "name", "parentId"],
      });
      const inventory = parse(
        z.object({ list: z.array(z.object({ id: jmapIdSchema, name: z.string(), parentId: jmapIdSchema.nullable() })) }),
        result,
        "Cleanup inventory",
      );
      const owned = inventory.list.filter((folder) => createdIds.has(folder.id) || ownedNames.has(folder.name));
      owned.sort((a, b) => Number(b.parentId !== null) - Number(a.parentId !== null));
      const failures: string[] = [];
      for (const folder of owned) {
        try {
          const deleted = await set("Cleanup destroy", { destroy: [folder.id] }, signal);
          check(deleted.destroyed?.includes(folder.id), "Cleanup destroy: deletion acknowledged");
        } catch {
          failures.push("Cleanup destroy: could not delete an owned mailbox");
        }
      }
      check(failures.length === 0, "Cleanup destroy: all owned mailboxes deleted");
    }
  }, 30_000);

  test("verifyJmap rejects an incorrect password with a typed error", async () => {
    let failure: unknown;
    try {
      await verifyJmap({ ...access(AbortSignal.timeout(10_000)), authorization: wrongAuthorization }, dependencies);
    } catch (error) {
      failure = error;
    }
    // Setup mode may expose the public Session with no accounts instead of 401.
    check(
      (failure instanceof JmapHttpError && failure.status === 401) || (failure instanceof JmapError && failure.code === "JMAP_ACCOUNT"),
      "Authentication: typed HTTP 401 or missing primary account error",
    );
  }, 30_000);
});
