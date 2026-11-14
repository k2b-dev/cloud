import { beforeAll, expect, test } from "bun:test";
import { memoryStore, nessi } from "@k2b/nessi";
import { complete } from "@k2b/nessi/ai";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { setAiCredential } from "./credentials";
import { migrateCloudAi } from "./migrate";
import { aiModelCatalog, readAiModelProfiles } from "./model-catalog";
import { aiSettingsFixture } from "./model-fixture";
import { inferenceProvider } from "./quota-provider";
import { resolveAiModelFromState } from "./settings";
import { runAiStructured } from "./structured";

const suite = databaseSuite();
suite("catalog output ceilings reach the provider request", () => {
  beforeAll(migrateCloudAi);
  for (const type of ["openai-compatible", "openai"] as const)
    test(`${type}: reported output limit survives catalog resolution without a known context window or reasoning setting`, async () => {
      const id = `output-budget-${crypto.randomUUID()}`;
      const requests: Record<string, unknown>[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          requests.push(z.record(z.string(), z.unknown()).parse(await request.json()));
          return new Response(
            'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"ok\\"}"}}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":10}}}\n\n' +
              "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      });
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
        VALUES(${id},'local','user','Output budget fixture') RETURNING id`;
      if (!user) throw new Error("Missing test user");
      try {
        await aiModelCatalog.createProvider({ id, type, label: "Fixture", baseUrl: `${server.url}v1`, dataBoundary: "private" }, user.id);
        if (type === "openai") await setAiCredential(id, "fixture-key");
        const [model] = await aiModelCatalog.createModels(
          id,
          [{ id, label: "Reasoner", providerModel: "glm-5-3", outputTokenLimit: 1_048_576 }],
          user.id,
        );
        if (!model) throw new Error("Missing test model");
        const resolve = async () =>
          resolveAiModelFromState(aiSettingsFixture({ profiles: await readAiModelProfiles() }), { kind: "selectable" }, { id });
        const resolved = await resolve();
        expect(resolved.profile).toMatchObject({ outputTokenLimit: 1_048_576 });
        expect(resolved.profile.contextWindow).toBeUndefined();
        expect(resolved.profile.maxOutputTokens).toBeUndefined();
        expect(resolved.profile.reasoningEffort).toBeUndefined();
        expect(resolved.provider.capabilities.thinking).toBe(type === "openai-compatible");
        const run = async (current = resolved, maxOutputTokens?: number) =>
          complete(inferenceProvider(current.provider, current.profile, { kind: "chat", task: id, userId: user.id }), {
            messages: [{ role: "user", content: [{ type: "text", text: "Write a long answer" }] }],
            maxOutputTokens,
          });
        const answer = await run();
        expect(answer.usage?.reasoning).toBe(10);
        expect(requests[0]).toMatchObject({ model: "glm-5-3", max_completion_tokens: 1_048_576 });
        expect(requests[0]).not.toHaveProperty("reasoning_effort");
        expect(requests[0]).not.toHaveProperty("max_tokens");

        // Assistant chat and print mode use the same executor loop; tools and structured calls share admission.
        for await (const _event of nessi({
          provider: inferenceProvider(resolved.provider, resolved.profile, { kind: "chat", task: id, userId: user.id }),
          store: memoryStore(),
          systemPrompt: "Answer the request.",
          input: "Write a long answer",
        })) {
          // Drain the actual loop, including its provider request and accounting.
        }
        expect(requests[1]).toHaveProperty("max_completion_tokens", 1_048_576);
        const structured = await runAiStructured({
          task: id,
          input: "Return an answer",
          output: z.object({ answer: z.string() }),
          resolveModel: async () => resolved,
        });
        expect(structured.output).toEqual({ answer: "ok" });
        expect(requests[2]).toHaveProperty("max_completion_tokens", 1_048_576);

        await aiModelCatalog.updateModel(id, { maxOutputTokens: 65_536 }, model.revision, user.id);
        const explicit = await resolve();
        await run(explicit);
        expect(requests[3]).toHaveProperty("max_completion_tokens", 65_536);
        await run(explicit, 32_768);
        expect(requests[4]).toHaveProperty("max_completion_tokens", 32_768);
      } finally {
        server.stop(true);
        await sql`DELETE FROM ai.structured_runs WHERE task=${id}`;
        await sql`DELETE FROM ai.inference_calls WHERE task=${id}`;
        await sql`DELETE FROM ai.providers WHERE id=${id}`;
        await sql`DELETE FROM ai.model_access_resources WHERE model_id=${id}`;
        await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
      }
    });
});
