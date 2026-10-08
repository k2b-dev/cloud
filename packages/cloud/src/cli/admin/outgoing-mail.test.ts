import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "../index";
import { outgoingMailCommands } from "./outgoing-mail";

const module = defineCliCommands({ name: "admin", summary: "Outgoing mail", commands: outgoingMailCommands });
const input = {
  name: "Alerts",
  fromAddress: "alerts@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15728640,
};
const invoke = async (
  args: string[],
  flags: CloudCliFlags = {},
  result: unknown = {},
  requests: { path: string; method: string; body: unknown }[] = [],
  mode: CloudCliOutputMode = "json",
) => {
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args: ["outgoing-mail", ...args],
    flags,
    options: { profile: "test", server: "http://test", token: "test", output: mode },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(result);
    },
    readJson: async (response) => response.json(),
    print: (value) => {
      output.push(value);
    },
    write: async () => {},
    error: () => {},
    json: (value) => {
      output.push(value);
    },
    jsonLine: (value) => {
      output.push(value);
    },
    table: (rows) => {
      output.push(rows);
    },
  };
  await module.run(ctx);
  return { requests, output };
};
test("log cancel accepts exactly one ID or batch, confirms, and forwards the batch response", async () => {
  const batchId = crypto.randomUUID();
  const result = { batchId, cancelled: 3 };
  expect(await invoke(["log", "cancel"], { batch: batchId, yes: true }, result)).toEqual({
    requests: [{ path: `/api/admin/core/outgoing-mail/batches/${batchId}/cancel`, method: "POST", body: null }],
    output: [result],
  });
  expect((await invoke(["log", "cancel", "message"], { yes: true })).requests[0]?.path).toBe(
    "/api/admin/core/outgoing-mail/messages/message/cancel",
  );
  for (const [args, flags] of [
    [["log", "cancel"], { yes: true }],
    [["log", "cancel", "message"], { batch: batchId, yes: true }],
    [["log", "cancel"], { batch: batchId }],
  ] satisfies [string[], CloudCliFlags][]) {
    const requests: { path: string; method: string; body: unknown }[] = [];
    await expect(invoke(args, flags, {}, requests)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  }
});
test("profile reads and replacement forward exact API paths, revision and JSON output", async () => {
  const profiles = { items: [] };
  expect(await invoke(["profiles", "list"], {}, profiles)).toEqual({
    requests: [{ path: "/api/admin/core/outgoing-mail/profiles", method: "GET", body: null }],
    output: [profiles],
  });
  expect((await invoke(["profiles", "get", "alerts"])).requests[0]?.path).toBe("/api/admin/core/outgoing-mail/profiles/alerts");
  const config = { ...input, revision: 3 };
  expect((await invoke(["profiles", "put", "alerts"], { config: JSON.stringify(config) })).requests[0]).toMatchObject({
    method: "PUT",
    body: config,
  });
  await expect(invoke(["profiles", "put", "alerts"], { config: JSON.stringify({ ...input, smtpPassword: "secret" }) })).rejects.toThrow(
    "--config-file",
  );
  await expect(invoke(["profiles", "put", "alerts"], { config: JSON.stringify({ ...input, smtpPassword: null }) })).rejects.toThrow(
    "--config-file",
  );
});
test("retention show and set forward exact API paths, both day counts and JSON output", async () => {
  const retention = { contentDays: 30, recordDays: 90 };
  expect(await invoke(["retention", "show"], {}, retention)).toEqual({
    requests: [{ path: "/api/admin/core/outgoing-mail/retention", method: "GET", body: null }],
    output: [retention],
  });
  expect(await invoke(["retention", "set"], { "content-days": "30", "record-days": "90", yes: true }, retention)).toEqual({
    requests: [{ path: "/api/admin/core/outgoing-mail/retention", method: "PUT", body: retention }],
    output: [retention],
  });
});
test("retention set requires both positive integer flags, valid ordering and --yes before a request", async () => {
  const invalid: CloudCliFlags[] = [
    {},
    { "content-days": "30" },
    { "record-days": "90" },
    { "content-days": "0", "record-days": "90" },
    { "content-days": "30", "record-days": "-1" },
    { "content-days": "1.5", "record-days": "90" },
    { "content-days": "30", "record-days": "90.5" },
    { "content-days": "90", "record-days": "30" },
    { "content-days": "30garbage", "record-days": "90" },
  ];
  for (const flags of invalid) {
    const requests: { path: string; method: string; body: unknown }[] = [];
    await expect(invoke(["retention", "set"], { ...flags, yes: true }, {}, requests)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  }
  const requests: { path: string; method: string; body: unknown }[] = [];
  await expect(invoke(["retention", "set"], { "content-days": "30", "record-days": "90" }, {}, requests)).rejects.toThrow("--yes");
  expect(requests).toHaveLength(0);
  expect((await invoke(["retention", "set"], { "content-days": "30", "record-days": "30", yes: true })).requests[0]?.body).toEqual({
    contentDays: 30,
    recordDays: 30,
  });
});
test("retention commands preserve the JSONL output contract", async () => {
  const retention = { contentDays: 30, recordDays: 90 };
  expect((await invoke(["retention", "show"], {}, retention, [], "jsonl")).output).toEqual([retention]);
  expect(
    (await invoke(["retention", "set"], { "content-days": "30", "record-days": "90", yes: true }, retention, [], "jsonl")).output,
  ).toEqual([retention]);
});
test("destructive commands require confirmation and DELETE handles an empty 204", async () => {
  for (const action of ["set-default", "delete"]) {
    await expect(invoke(["profiles", action, "alerts"])).rejects.toThrow("--yes");
    const response = await invoke(["profiles", action, "alerts"], { yes: true });
    expect(response.requests[0]?.method).toBe(action === "delete" ? "DELETE" : "POST");
    expect(response.requests[0]?.path).toBe(`/api/admin/core/outgoing-mail/profiles/alerts${action === "delete" ? "" : "/default"}`);
    if (action === "delete") expect(response.output).toEqual([{ deleted: "alerts" }]);
  }
  expect((await invoke(["profiles", "test", "alerts"], { to: "recipient@example.org" })).requests[0]?.body).toEqual({
    recipient: "recipient@example.org",
  });
});
test("app access default, selected and none flags forward the expected policies", async () => {
  expect((await invoke(["apps", "list"], {}, { items: [], defaultProfile: null })).requests[0]?.path).toBe(
    "/api/admin/core/outgoing-mail/apps",
  );
  for (const [flags, body] of [
    [{ default: true }, { mode: "default" }],
    [{ profiles: "a,b" }, { mode: "selected", profiles: ["a", "b"] }],
    [{ none: true }, { mode: "selected", profiles: [] }],
  ] as const) {
    const response = await invoke(["apps", "set", "inventory"], { ...flags, yes: true });
    expect(response.requests[0]).toEqual({ path: "/api/admin/core/outgoing-mail/apps/inventory", method: "PUT", body });
    await expect(invoke(["apps", "set", "inventory"], flags)).rejects.toThrow("--yes");
  }
  const invalid: CloudCliFlags[] = [{}, { default: true, none: true }, { profiles: "" }, { profiles: "a,,b" }];
  for (const flags of invalid) await expect(invoke(["apps", "set", "inventory"], { ...flags, yes: true })).rejects.toThrow();
});

test("file input accepts passwords and rejects conflicting input sources", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(import.meta.dir, ".outgoing-mail-test-"));
  const file = join(dir, "sender.json");
  const config = { ...input, smtpPassword: "fixture-password" };
  try {
    await writeFile(file, JSON.stringify(config));
    expect((await invoke(["profiles", "put", "alerts"], { "config-file": file })).requests[0]?.body).toEqual(config);
    await expect(invoke(["profiles", "put", "alerts"], { config: "{}", "config-file": file })).rejects.toThrow("Pass only one");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("stdin input forwards credentials without inline arguments", async () => {
  const { spyOn } = await import("bun:test");
  const config = { ...input, smtpPassword: "fixture-password" };
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue(JSON.stringify(config));
  try {
    expect((await invoke(["profiles", "put", "alerts"], { stdin: true })).requests[0]?.body).toEqual(config);
    expect(stdin).toHaveBeenCalledTimes(1);
  } finally {
    stdin.mockRestore();
  }
});

test("malformed profile JSON from stdin never exposes secrets or sends a request", async () => {
  const { spyOn } = await import("bun:test");
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue('{"smtpPassword":MySecret123}');
  const requests: { path: string; method: string; body: unknown }[] = [];
  try {
    const error = await invoke(["profiles", "put", "noreply"], { stdin: true }, {}, requests).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Invalid outgoing mail profile JSON." });
    expect(String(error)).not.toContain("MySecret123");
    expect(requests).toHaveLength(0);
  } finally {
    stdin.mockRestore();
  }
});

test("log list forwards filters and cursor without exposing content", async () => {
  const page = { items: [], page: 1, perPage: 20, total: 0, hasNext: false };
  const result = await invoke(
    ["log", "list"],
    {
      app: "inventory",
      profile: "alerts",
      status: "queued,failed",
      since: "2026-10-01T00:00:00Z",
      ref: "order:42",
      recipient: "@example.org",
      cursor: "abc",
      limit: "20",
    },
    page,
  );
  const url = new URL(result.requests[0]!.path, "http://test");
  expect(url.pathname).toBe("/api/admin/core/outgoing-mail/messages");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    app: "inventory",
    profile: "alerts",
    status: "queued,failed",
    since: "2026-10-01T00:00:00Z",
    ref: "order:42",
    recipient: "@example.org",
    cursor: "abc",
    limit: "20",
  });
  expect(result.output).toEqual([page]);
  await expect(invoke(["log", "list"], { limit: "101" })).rejects.toThrow("1 to 100");
});
test("log show content uses the audited endpoint and cancel needs --yes", async () => {
  expect((await invoke(["log", "show", "id"])).requests[0]?.path).toBe("/api/admin/core/outgoing-mail/messages/id");
  expect((await invoke(["log", "show", "id"], { content: true })).requests[0]?.path).toBe(
    "/api/admin/core/outgoing-mail/messages/id/content",
  );
  const requests: { path: string; method: string; body: unknown }[] = [];
  await expect(invoke(["log", "cancel", "id"], {}, {}, requests)).rejects.toThrow("--yes");
  expect(requests).toHaveLength(0);
  expect((await invoke(["log", "cancel", "id"], { yes: true })).requests[0]).toEqual({
    path: "/api/admin/core/outgoing-mail/messages/id/cancel",
    method: "POST",
    body: null,
  });
});

test("IMAP config is accepted but nested passwords require file or stdin", async () => {
  const imap = { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX" };
  const config = { ...input, imap };
  expect((await invoke(["profiles", "put", "alerts"], { config: JSON.stringify(config) })).requests[0]?.body).toEqual(config);
  for (const password of ["imap-secret", null]) {
    await expect(
      invoke(["profiles", "put", "alerts"], { config: JSON.stringify({ ...config, imap: { ...imap, password } }) }),
    ).rejects.toThrow("--config-file");
  }
  const { spyOn } = await import("bun:test");
  const secretConfig = { ...config, imap: { ...imap, password: "imap-secret" } };
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue(JSON.stringify(secretConfig));
  try {
    expect((await invoke(["profiles", "put", "alerts"], { stdin: true })).requests[0]?.body).toEqual(secretConfig);
  } finally {
    stdin.mockRestore();
  }
});

test("profile text output shows IMAP host/folder and bounce check, error or off", async () => {
  const imap = { host: "imap.example.org", folder: "INBOX" };
  const checkedAt = "2026-10-08T00:00:00.000Z";
  const items = [
    { key: "checked", imap, bounces: { checkedAt, error: null } },
    { key: "error", imap, bounces: { checkedAt, error: "Connection failed" } },
    { key: "off", imap: null, bounces: null },
  ];
  const result = await invoke(["profiles", "list"], {}, { items }, [], "text");
  expect(result.output[0]).toMatchObject([
    { key: "checked", imap: "imap.example.org/INBOX", bounces: checkedAt },
    { key: "error", imap: "imap.example.org/INBOX", bounces: "Connection failed" },
    { key: "off", imap: "off", bounces: "off" },
  ]);
  for (const item of items) {
    const read = await invoke(["profiles", "get", item.key], {}, item, [], "text");
    expect(read.output[1]).toBe(`Bounces: ${item.bounces?.error ?? item.bounces?.checkedAt ?? "off"}`);
  }
});
