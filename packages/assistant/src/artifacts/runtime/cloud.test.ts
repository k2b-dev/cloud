import { expect, test } from "bun:test";
import { createBridge } from "./bridge";
import { createCloud } from "./cloud";
import { WorkerMessage } from "./protocol";

test("cloud is frozen, flat database and personal KV carry no caller identity", async () => {
  const calls: unknown[] = [];
  const cloud = createCloud(
    async (method, args) => {
      calls.push({ method, args });
      return null;
    },
    { locale: "de-DE", timeZone: "Europe/Berlin", user: { id: "trusted", name: "Viewer" } },
  );
  expect(Object.isFrozen(cloud)).toBe(true);
  expect(Object.isFrozen(cloud.db)).toBe(true);
  await cloud.db.get("tasks", 4);
  await cloud.kv.user.set("settings", { ready: true });
  expect(calls).toEqual([
    { method: "database", args: [{ operation: "get", table: "tasks", id: 4 }] },
    { method: "storage", args: [{ scope: "user", area: "kv", operation: "write", key: "settings", value: { ready: true } }] },
  ]);
  expect(cloud.user).toEqual({ id: "trusted", name: "Viewer" });
  expect(Object.keys(cloud.ai)).toEqual(["text", "classify", "extract"]);
  for (const name of ["connect", "tables", "createTable", "table"]) expect(name in cloud.db).toBe(false);
  expect("local" in cloud.kv).toBe(false);
});
test("bridge errors are CloudError and cancellation releases pending requests", async () => {
  const sent: unknown[] = [];
  const bridge = createBridge((message) => sent.push(message));
  const denied = bridge.rpc("http.fetch", []);
  bridge.result({ id: 0, error: "The request was refused.", code: "HTTP_DENIED" });
  await expect(denied).rejects.toMatchObject({ name: "CloudError", code: "denied" });
  const controller = new AbortController();
  const cancelled = bridge.rpc("pdf", [], controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "CloudError", code: "cancelled" });
  expect(sent.at(-1)).toEqual({ type: "cancel", id: 1 });
});
test("removed browser storage RPCs are rejected by the transport", () => {
  for (const method of ["store.get", "opfs.write"])
    expect(WorkerMessage.safeParse({ type: "rpc", id: 0, method, args: [] }).success).toBe(false);
});

test("cloud HTTP preserves task access denial through the bridge", async () => {
  const bridge = createBridge(() => {});
  const cloud = createCloud(bridge.rpc, { locale: "en-US", timeZone: "UTC", user: { id: "viewer", name: "Viewer" } });
  const pending = cloud.http.fetch("https://example.com/");
  bridge.result({ id: 0, code: "BACKGROUND_ACCESS_DENIED", error: "Task runtime access denied for this HTTP target." });
  await expect(pending).rejects.toMatchObject({
    name: "CloudError",
    code: "denied",
    message: expect.stringContaining("access denied"),
  });
});

test("shared file listing follows every sorted page", async () => {
  const paths = Array.from({ length: 2005 }, (_, i) => `file-${String(i).padStart(4, "0")}`);
  const calls: unknown[] = [];
  const cloud = createCloud(
    async (method, args) => {
      expect(method).toBe("storage");
      const request = args?.[0];
      if (!request || typeof request !== "object" || !("after" in request) || typeof request.after !== "string")
        throw new Error("Missing cursor");
      calls.push(request);
      const after = request.after;
      return paths.filter((path) => path > after).slice(0, 1000);
    },
    { locale: "en-US", timeZone: "UTC", user: null },
  );
  expect(await cloud.files.list()).toEqual(paths);
  expect(calls).toHaveLength(3);
});

test("PDF accepts Html and escapes its title; invalid async calls reject with CloudError", async () => {
  const requests: unknown[] = [];
  const cloud = createCloud(
    async (_method, args) => {
      requests.push(args?.[0]);
      return new Blob(["pdf"]);
    },
    { locale: "en-US", timeZone: "UTC", user: null },
  );
  await cloud.pdf.render({ html: cloud.html`<h1>Hello</h1>`, title: "A & B" });
  expect(requests[0]).toMatchObject({ operation: "render", html: "<title>A &amp; B</title><h1>Hello</h1>" });
  await expect(Reflect.apply(cloud.pdf.render, null, [{}])).rejects.toMatchObject({ name: "CloudError", code: "invalid" });
  await expect(cloud.ai.classify({ prompt: "Pick", input: null, choices: ["same", "same"] })).rejects.toMatchObject({
    name: "CloudError",
    code: "invalid",
  });
  expect(requests).toHaveLength(1);
});

test("lazy libraries reject HTML responses as unavailable before importing and allow retries", async () => {
  let requests = 0;
  const cloud = createCloud(
    async () => {
      requests++;
      return "<!doctype html><body>Missing runtime route</body>";
    },
    { locale: "en-US", timeZone: "UTC", user: null },
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(cloud.sheet.parseCsv("x\n1")).rejects.toMatchObject({
      name: "CloudError",
      code: "unavailable",
      message: expect.stringContaining("did not return JavaScript"),
    });
  }
  expect(requests).toBe(2);
});
