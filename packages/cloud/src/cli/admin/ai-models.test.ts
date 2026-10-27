import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext } from "../index";
import { aiModelCommands } from "./ai-models";

const module = defineCliCommands({ name: "admin", summary: "AI catalog", commands: aiModelCommands });
const invoke = async (args: string[], yes = true) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags: { yes },
    options: { profile: "test", server: "http://test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Response.json({ assignments: [{ slot: "fast", revision: 7 }] });
    },
    readJson: (response) => response.json(),
    print: (value) => {
      output.push(value);
    },
    write: async (value) => {
      output.push(value);
    },
    error: (value) => {
      output.push(value);
    },
    jsonLine: (value) => {
      output.push(value);
    },
    json: (value) => {
      output.push(value);
    },
    table: () => {},
  };
  await module.run(ctx);
  return { requests, output };
};
test("class assignment preserves variant IDs and uses the fetched revision", async () => {
  const { requests, output } = await invoke(["ai", "classes", "set", "fast", "chat:deep"]);
  expect(requests[1]).toEqual({
    path: "/api/admin/core/ai/assignments/fast",
    method: "PUT",
    body: { variantId: "chat:deep", revision: 7 },
  });
  expect(output).toHaveLength(1);
  expect((await invoke(["ai", "classes", "set", "fast", "none"])).requests[1]?.body).toEqual({ variantId: null, revision: 7 });
});
test("invalid slots and unconfirmed mutations stop before HTTP writes", async () => {
  await expect(invoke(["ai", "classes", "set", "unknown", "chat"])).rejects.toThrow();
  await expect(invoke(["ai", "classes", "set", "fast", "chat"], false)).rejects.toThrow("--yes");
});
