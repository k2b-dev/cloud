import { expect, test } from "bun:test";
import * as activity from "./activity";
import { currentActivityId, filegateException, type Intent } from "./activity";
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
  const transport: typeof fetch = Object.assign(
    async () => {
      requests++;
      return Response.json({ path: intent.pathAfter, directory: true });
    },
    { preconnect: fetch.preconnect },
  );
  return {
    client: connectFilegate({ url: intent.serverUrl, token: "test" }, transport),
    requests: () => requests,
    transport,
  };
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
test("the activity API does not expose its mutable authorization scope", () => {
  expect(activity).not.toHaveProperty("currentScope");
});
test("pending migration permissions cannot be changed through the exported table", () => {
  const methods = activity.PENDING_MIGRATION_METHODS;
  expect(Reflect.set(methods, "lifecycle.operation", ["remove"])).toBe(false);
  expect(activity.PENDING_MIGRATION).toEqual([]);
  expect(methods).toEqual({});
  expect(Reflect.set(activity.PENDING_MIGRATION, "0", "lifecycle.operation")).toBe(false);
});
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
test("probe exceptions expose no activity identity", async () => {
  expect(currentActivityId()).toBeNull();
  await filegateException("lifecycle.probe", async () => {
    expect(currentActivityId()).toBeNull();
  });
});
