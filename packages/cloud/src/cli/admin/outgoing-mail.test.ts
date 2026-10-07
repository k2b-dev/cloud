import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
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
const invoke = async (args: string[], flags: CloudCliFlags = {}, result: unknown = {}) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args: ["outgoing-mail", ...args],
    flags,
    options: { profile: "test", server: "http://test", token: "test", output: "json" },
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
    print: () => {},
    write: async () => {},
    error: () => {},
    json: (value) => {
      output.push(value);
    },
    jsonLine: () => {},
    table: () => {},
  };
  await module.run(ctx);
  return { requests, output };
};
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
