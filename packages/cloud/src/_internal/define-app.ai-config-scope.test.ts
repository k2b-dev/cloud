import { expect, test } from "bun:test";
import { readAiConfigOnce } from "../ai/config-reads";
import { inventory, publishedEntry } from "./define-app.test-fixture";

// The scope that lets a request read the AI configuration once is mounted by `defineApp` itself, for every app; without
// it every read falls back to its own statement (22 instead of 6 on a page that asks from several parts).
test("an app's GET reads the AI configuration once, because defineApp mounts the request scope", async () => {
  let reads = 0;
  const read = async () => ({ reads: ++reads });
  await publishedEntry(
    inventory,
    async (server) => {
      const response = await server.fetch(new Request("http://inventory:3000/app/inventory"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ same: true });
    },
    undefined,
    {
      fetch: async () => {
        const first = await readAiConfigOnce("scope-test", read);
        const second = await readAiConfigOnce("scope-test", read);
        return Response.json({ same: first === second });
      },
    },
  );
  expect(reads).toBe(1);
});
