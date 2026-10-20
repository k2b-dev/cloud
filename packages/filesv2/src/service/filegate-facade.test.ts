import { expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import { currentScope, filegateException, type Intent, pendingMigration } from "./activity";
import { connectFilegate, FilesFilegate, FilesRoot } from "./filegate-facade";

const intent: Intent = {
  action: "folder.create",
  serverUrl: "https://filegate.test",
  root: "cloud",
  baseId: null,
  directory: true,
  name: "new",
  pathAfter: "home/alice/new",
};
function fixture() {
  let requests = 0;
  let refusal: FilegateError | undefined;
  const transport: typeof fetch = Object.assign(
    async () => {
      requests++;
      if (refusal) return Response.json({ error: refusal.code, message: refusal.message }, { status: refusal.status });
      return Response.json({ path: intent.pathAfter, directory: true });
    },
    { preconnect: fetch.preconnect },
  );
  return {
    client: connectFilegate({ url: intent.serverUrl, token: "test" }, transport),
    requests: () => requests,
    refuse: () => {
      refusal = new FilegateError(409, "path_conflict", "exists");
    },
    transport,
  };
}
// Install an activity-shaped store without opening a database connection. Only fileAction
// creates this scope in production; the guard reads the same AsyncLocalStorage here.
function inActivity<T>(run: () => Promise<T>, closed = false): Promise<T> {
  return pendingMigration("files.rename", () => {
    const scope = currentScope();
    if (!scope) throw new Error("scope missing in fixture");
    Object.assign(scope, { kind: "activity", id: "test", intent, closed, sent: 0, refused: undefined });
    return run();
  });
}
const mutations: Record<string, (root: FilesRoot) => Promise<unknown>> = {
  mkdir: (root) => root.mkdir("home/alice/new"),
  put: (root) => root.put("home/alice/new", new Blob(["data"])),
  createSession: (root) => root.createSession("home/alice/new", 4),
  commitSession: (root) => root.commitSession("session"),
  abortSession: (root) => root.abortSession("session"),
  transfer: (root) => root.transfer("home/alice/new", "cloud", "other"),
  restore: (root) => root.restore("home/alice/new", "version"),
  copyVersion: (root) => root.copyVersion("home/alice/new", "version", "cloud", "other"),
  updateVersion: (root) => root.updateVersion("home/alice/new", "version", { pinned: false }),
  deleteVersion: (root) => root.deleteVersion("home/alice/new", "version"),
  remove: (root) => root.remove("home/alice/new"),
};
test.each(Object.entries(mutations))("%s fails closed, including derived clients and roots", async (_name, mutate) => {
  const f = fixture();
  const identity = { uid: 1001, gid: 2001 };
  expect(f.client.as(identity)).toBeInstanceOf(FilesFilegate);
  for (const root of [f.client.root("cloud"), f.client.as(identity).root("cloud"), f.client.root("cloud").as(identity)]) {
    expect(root).toBeInstanceOf(FilesRoot);
    await expect(mutate(root)).rejects.toMatchObject({ code: "activity_scope_missing", status: 500 });
  }
  expect(f.requests()).toBe(0);
});
test("no SDK escape hatch exists on instances or prototypes", () => {
  const f = fixture();
  for (const object of [f.client, f.client.root("cloud"), f.client.as({ uid: 1, gid: 1 }).root("cloud")]) {
    const keys = [...Object.getOwnPropertyNames(object), ...Object.getOwnPropertyNames(Object.getPrototypeOf(object))];
    for (const key of ["raw", "json", "fetch", "client", "transferUrl", "setOwnership", "setACL", "snapshot", "prune", "directUpload"])
      expect(keys).not.toContain(key);
  }
  expect(
    Object.keys(
      f.client.directSession({
        url: "https://filegate.test/v1/direct/test.signature",
        expires: "2030-01-01T00:00:00Z",
        operations: ["write"],
      }),
    ),
  ).toEqual(["put"]);
});
test("closed activity refuses a stray write before transport", async () => {
  const f = fixture();
  await expect(inActivity(() => f.client.root("cloud").mkdir(intent.pathAfter!), true)).rejects.toMatchObject({
    code: "activity_scope_missing",
  });
  expect(f.requests()).toBe(0);
});
test("named pending migration allows the existing write", async () => {
  const f = fixture();
  await pendingMigration("files.ensure_trash", () => f.client.root("cloud").mkdir("home/alice/trash"));
  expect(f.requests()).toBe(1);
});
test.each(["home/alice/new", "home/alice", "home"])("folder intent permits target or ancestor %s", async (path) => {
  const f = fixture();
  await inActivity(() => f.client.as({ uid: 1, gid: 1 }).root("cloud").as({ uid: 1, gid: 1 }).mkdir(path));
  expect(f.requests()).toBe(1);
});
test.each(["home/alice/sibling", "home/alice/new/child", "home/alice-other"])("folder intent refuses %s", async (path) => {
  const f = fixture();
  await expect(inActivity(() => f.client.root("cloud").mkdir(path))).rejects.toMatchObject({ code: "activity_scope_mismatch" });
  expect(f.requests()).toBe(0);
});
test("folder intent refuses another root or server", async () => {
  const f = fixture();
  const other = connectFilegate({ url: "https://other.test", token: "test" }, f.transport);
  for (const root of [f.client.root("other"), other.root("cloud")])
    await expect(inActivity(() => root.mkdir(intent.pathAfter!))).rejects.toMatchObject({ code: "activity_scope_mismatch" });
  expect(f.requests()).toBe(0);
});
test.each(Object.entries(mutations).filter(([name]) => name !== "mkdir"))("folder intent refuses %s", async (_name, mutate) => {
  const f = fixture();
  await expect(inActivity(() => mutate(f.client.root("cloud")))).rejects.toMatchObject({ code: "activity_scope_mismatch" });
  expect(f.requests()).toBe(0);
});
test("probe exception only permits probe mkdir/remove", async () => {
  const f = fixture();
  const root = f.client.root("cloud");
  await filegateException("lifecycle.probe", async () => {
    await root.mkdir("home/.filesv2-owner-test");
    await root.remove("home/.filesv2-owner-test");
    for (const path of ["home/regular", "home/.filesv2-owner-test/child"]) {
      await expect(root.mkdir(path)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
      await expect(root.remove(path)).rejects.toMatchObject({ code: "activity_scope_mismatch" });
    }
    await expect(root.put("home/.filesv2-owner-test", new Blob())).rejects.toMatchObject({ code: "activity_scope_mismatch" });
  });
  expect(f.requests()).toBe(2);
});
test("activity scope counts sent requests and records the exact Filegate refusal", async () => {
  const f = fixture();
  f.refuse();
  await inActivity(async () => {
    try {
      await f.client.root("cloud").mkdir(intent.pathAfter!);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FilegateError);
      const scope = currentScope();
      if (scope?.kind !== "activity") throw new Error("missing activity");
      expect(scope.sent).toBe(1);
      expect(scope.refused).toBe(error);
    }
  });
});
