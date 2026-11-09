import { expect, spyOn, test } from "bun:test";
import { aiDecisionInput } from "../../../core/src/ai-decision-capability";
import { aiGenerationInput, aiGenerationOutputSchema } from "../../../core/src/ai-generation-capability";
import * as codeAiLoop from "../../../core/src/code/ai-loop";

const file = { id: "sealed-ref-from-this-run", mediaType: "application/pdf", size: 100 };
const request = { task: "invoice.extract", prompt: "Extract invoice lines.", input: {}, output: { type: "text", maxChars: 100 } };
test("AI capability transports accept FileRefs and bound SDK tool descriptions, not base64 decision images", () => {
  expect(
    aiGenerationInput.safeParse({
      ...request,
      files: [file],
      fileTools: false,
      tools: [{ capability: "mail.message.search", target: null }],
    }).success,
  ).toBe(true);
  const decision = { task: "invoice.classify", state: {}, questions: { valid: { type: "noul", instructions: "Is this an invoice?" } } };
  expect(aiDecisionInput.safeParse({ ...decision, files: [file] }).success).toBe(true);
  expect(aiDecisionInput.safeParse({ ...decision, images: [{ data: "YQ==", mediaType: "image/png" }] }).success).toBe(false);
});

test("JSON output accepts bounded lists of strict line objects and enforces list and text bounds", () => {
  const output = aiGenerationInput.parse({
    ...request,
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            maxItems: 2,
            items: {
              type: "object",
              properties: { label: { type: "string", maxLength: 10 }, total: { type: "number" } },
              required: ["label", "total"],
              additionalProperties: false,
            },
          },
        },
        required: ["lines"],
        additionalProperties: false,
      },
    },
  }).output;
  const schema = aiGenerationOutputSchema(output);
  expect(schema.safeParse({ lines: [{ label: "Chair", total: 120 }] }).success).toBe(true);
  for (const lines of [
    Array(3).fill({ label: "Chair", total: 120 }),
    [{ label: "a".repeat(11), total: 120 }],
    [{ label: "Chair", total: "120" }],
    [{ label: "Chair", total: 120, extra: true }],
  ])
    expect(schema.safeParse({ lines }).success).toBe(false);
  const unbounded = {
    ...request,
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: { lines: { type: "array", items: { type: "string" } } },
        required: ["lines"],
        additionalProperties: false,
      },
    },
  };
  expect(aiGenerationInput.safeParse(unbounded).success).toBe(false);
});

test("a public AI request cannot attach a file or bind tools without direct signed Code provenance", async () => {
  const { geoTestContext } = await import("../services/geo/geo.test-fixture");
  const { aiGenerationQuery } = await import("../../../core/src/ai-generation-capability");
  const { aiDecisionQuery } = await import("../../../core/src/ai-decision-capability");
  const context = {
    ...geoTestContext,
    actor: geoTestContext.actor!,
    accessSubject: geoTestContext.accessSubject!,
    user: null,
    locale: "en",
    requestId: "file-fence",
    origin: "http" as const,
    signal: new AbortController().signal,
  };
  expect(await aiGenerationQuery.run(aiGenerationInput.parse({ ...request, files: [file] }), context)).toMatchObject({
    ok: false,
    error: { code: "code_ai_run_required", status: 403 },
  });
  expect(
    await aiDecisionQuery.run(
      aiDecisionInput.parse({
        task: "classify",
        state: {},
        questions: { valid: { type: "noul", instructions: "Invoice?" } },
        files: [file],
      }),
      context,
    ),
  ).toMatchObject({ ok: false, error: { code: "code_ai_run_required", status: 403 } });
});

test("viewer call IDs satisfy the same normalized-call contract as direct SDK calls", async () => {
  const { codeAiFileToolOperation } = await import("../../../core/src/code/ai-loop");
  const { NormalizedCapabilityCallSchema } = await import("../contracts/capabilities");
  for (const name of ["view_image", "read_file"] as const) {
    const capability = codeAiFileToolOperation(name);
    expect(NormalizedCapabilityCallSchema.safeParse({ capability, target: null, refs: {}, input: {} }).success).toBe(true);
    expect(capability.startsWith("core.ai.")).toBe(false);
  }
});

test.each([
  [403, 403],
  [404, 404],
  [200, 403],
  [418, 403],
  [409, 403],
  [503, 403],
] as const)("file refusal status %s becomes %s through generation and decision capabilities", async (status, expected) => {
  const { geoTestContext } = await import("../services/geo/geo.test-fixture");
  const { aiGenerationQuery } = await import("../../../core/src/ai-generation-capability");
  const { aiDecisionQuery } = await import("../../../core/src/ai-decision-capability");
  const failure = Object.assign(new Error(`The owning app refused the file (${status}).`), { code: "code_file_source_refused", status });
  const prepare = spyOn(codeAiLoop, "prepareCodeAiLoop").mockRejectedValue(failure);
  const context = {
    ...geoTestContext,
    actor: geoTestContext.actor!,
    accessSubject: geoTestContext.accessSubject!,
    user: null,
    locale: "en",
    requestId: "file-refusal",
    origin: "http" as const,
    signal: new AbortController().signal,
  };
  try {
    const generate = await aiGenerationQuery.run(aiGenerationInput.parse({ ...request, files: [file] }), context);
    const decide = await aiDecisionQuery.run(
      aiDecisionInput.parse({
        task: "classify",
        state: {},
        questions: { valid: { type: "noul", instructions: "Invoice?" } },
        files: [file],
      }),
      context,
    );
    for (const result of [generate, decide])
      expect(result).toMatchObject({ ok: false, error: { code: failure.code, status: expected, message: failure.message } });
  } finally {
    prepare.mockRestore();
  }
});
