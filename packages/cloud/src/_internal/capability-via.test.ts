import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { type CapabilityExecutionContext, defineCapabilities } from "../contracts/capabilities";
import { compileCapabilities, invokeCompiledCapability, reviewCompiledCapability } from "./capabilities";
import { person } from "./define-app.test-fixture";

for (const origin of ["assistant", "mcp", "http", "app"] as const)
  test(`${origin} derives content provenance for execution and review, overriding supplied metadata`, async () => {
    const seen: CapabilityExecutionContext["via"][] = [];
    const compiled = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 2,
        actions: {
          post: {
            title: "Post",
            description: "Create visible content.",
            input: z.strictObject({ body: z.string().max(100).describe("Text to publish.") }),
            data: z.strictObject({ body: z.string() }),
            destructive: false,
            openWorld: false,
            approval: "rememberable",
            idempotency: "required",
            review: async (_input, context) => {
              seen.push(context.via);
              return ok({ message: "Post this text.", approvalScope: "example:post" });
            },
            run: async (input, context) => {
              seen.push(context.via);
              expect(context.idempotencyKey).toBe("retry-1");
              return ok({ data: input });
            },
          },
        },
      }),
    );
    const context: CapabilityExecutionContext = {
      actor: { kind: "user", user: person },
      accessSubject: { type: "user", userId: person.id },
      user: person,
      locale: "en",
      requestId: "via-test",
      origin,
      via: origin === "assistant" ? "mcp" : "assistant",
      signal: new AbortController().signal,
    };
    const request = {
      compiled,
      localId: "post",
      input: { body: "Hello" },
      expectedSchemaHash: compiled.manifest.actions[0]!.schemaHash,
      context,
    };
    expect((await reviewCompiledCapability(request)).ok).toBe(true);
    expect((await invokeCompiledCapability({ ...request, kind: "action", context: { ...context, idempotencyKey: "retry-1" } })).ok).toBe(
      true,
    );
    expect(seen).toEqual([
      origin === "assistant" || origin === "mcp" ? origin : null,
      origin === "assistant" || origin === "mcp" ? origin : null,
    ]);
    expect(
      (
        await invokeCompiledCapability({
          ...request,
          kind: "action",
          input: { body: "Hello", via: "assistant" },
          context: { ...context, idempotencyKey: "retry-2" },
        })
      ).ok,
    ).toBe(false);
    expect(seen).toHaveLength(2);
  });
