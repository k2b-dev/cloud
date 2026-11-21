import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  capabilityManifestEvolutionIssues,
  compileCapabilities,
  invokeCompiledCapability,
  parseCapabilityManifest,
  reviewCompiledCapability,
} from "../_internal/capabilities";
import {
  CapabilityActionCheckSchema,
  type CapabilityActionDefinition,
  type CapabilityExecutionContext,
  defineCapabilities,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "../contracts/capabilities";
import { capabilityContractIssues } from "../contracts/capability-compatibility";
import { approvalArgsDigest } from "../services/approvals";
import {
  capabilityCallDigest,
  capabilityCallFromTool,
  capabilityInvocationBody,
  capabilityToolInputSchema,
  normalizeCapabilityCall,
} from "./calls";
import { capabilityRequestHash } from "./claims";

const context: CapabilityExecutionContext = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Fixture",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-31T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read", "write"],
    credentialId: "22222222-2222-4222-8222-222222222222",
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  user: null,
  locale: "en",
  requestId: "fixture",
  origin: "http",
  signal: new AbortController().signal,
};
const action = {
  title: "Move",
  description: "Move a contact between books.",
  target: "book",
  refs: { targetBookId: "book" },
  code: false as const,
  input: z.object({ contactId: z.string().describe("Contact in the source book.") }).strict(),
  data: z.object({}).strict(),
  destructive: false,
  openWorld: false,
  idempotency: "none" as const,
  review: (_input: unknown, ctx: CapabilityExecutionContext) => ({
    ok: true as const,
    data: { message: `Move from ${ctx.target?.id} to ${ctx.refs?.targetBookId?.id}.` },
  }),
  run: (_input: unknown, ctx: CapabilityExecutionContext) => ({
    ok: true as const,
    data: { data: {}, summary: `Moved from ${ctx.target?.id} to ${ctx.refs?.targetBookId?.id}.` },
  }),
};
const definitions = defineCapabilities({
  protocolVersion: 2,
  types: { book: { title: "Book", description: "A contact book." } },
  actions: { move: action },
});
const compiled = compileCapabilities("fixture", definitions);
const operation = compiled.manifest.actions[0]!;
const body = {
  target: { type: "fixture.book", id: "source" },
  refs: { targetBookId: { type: "fixture.book", id: "destination" } },
  input: { contactId: "contact" },
};

describe("normalized capability calls", () => {
  test("digest binds capability, target, every ref and input; ordering is irrelevant", () => {
    const call = normalizeCapabilityCall("fixture", operation, body);
    const digest = capabilityCallDigest(call);
    expect(digest).toBe("a88e1196cc922f4fa4f7333dd33590e37d0ce6fa5909dd4a181f4962401e16a6");
    expect(
      capabilityCallDigest({ input: { contactId: "contact" }, refs: body.refs, target: body.target, capability: "fixture.move" }),
    ).toBe(digest);
    for (const changed of [
      { ...call, target: { ...body.target, id: "other" } },
      { ...call, target: { ...body.target, type: "fixture.other" } },
      { ...call, refs: { targetBookId: { ...body.refs.targetBookId, id: "other" } } },
      { ...call, input: { contactId: "other" } },
      { ...call, capability: "fixture.copy" },
    ])
      expect(capabilityCallDigest(changed)).not.toBe(digest);
    expect(approvalArgsDigest(call)).toBe(digest);
    expect(capabilityRequestHash(call)).toBe(digest);
  });

  test("flat tool fields round-trip to the HTTP call without changing the domain input", () => {
    expect(capabilityToolInputSchema(operation)).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { book: { type: "string" }, targetBookId: { type: "string" }, contactId: { type: "string" } },
      required: ["contactId", "book", "targetBookId"],
    });
    const call = capabilityCallFromTool("fixture", operation, { book: "source", targetBookId: "destination", contactId: "contact" });
    expect(call).toEqual({ capability: "fixture.move", ...body });
    expect(capabilityInvocationBody(call)).toEqual(body);
    expect(operation.inputSchema.properties).not.toHaveProperty("book");
  });

  test("requires the exact declared target and single refs, without undeclared coordinates", () => {
    expect(() => normalizeCapabilityCall("fixture", operation, { input: body.input, refs: body.refs })).toThrow("target");
    expect(() => capabilityCallFromTool("fixture", operation, { targetBookId: "destination", contactId: "contact" })).toThrow('"book"');
    for (const invalid of [
      { input: body.input },
      { ...body, target: { type: "other.book", id: "source" } },
      { ...body, refs: {} },
      { ...body, refs: { targetBookId: [body.refs.targetBookId] } },
      { ...body, refs: { ...body.refs, extra: body.target } },
    ])
      expect(() => normalizeCapabilityCall("fixture", operation, invalid)).toThrow();
    expect(() => normalizeCapabilityCall("fixture", { localId: "create" }, body)).toThrow();
    expect(() =>
      capabilityCallFromTool("fixture", operation, { book: "source", targetBookId: ["destination"], contactId: "contact" }),
    ).toThrow();
  });

  test("review and run receive the same validated coordinates, replacing caller-supplied context", async () => {
    const invocation = {
      compiled,
      localId: "move",
      ...body,
      expectedSchemaHash: operation.schemaHash,
      context: { ...context, target: { type: "fixture.book", id: "spoof" } },
    };
    expect(await reviewCompiledCapability(invocation)).toEqual({ ok: true, data: { message: "Move from source to destination." } });
    expect(await invokeCompiledCapability({ ...invocation, kind: "action" })).toEqual({
      ok: true,
      data: { data: {}, summary: "Moved from source to destination." },
    });
    const wrong = { ...invocation, target: { type: "foreign.book", id: "source" } };
    expect(await reviewCompiledCapability(wrong)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await invokeCompiledCapability({ ...wrong, kind: "action" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  test("legacy app-wide operations keep their input and wire shape", async () => {
    const legacy = compileCapabilities("fixture", {
      protocolVersion: 2,
      actions: { move: { ...action, target: undefined, refs: undefined, code: undefined } },
    });
    const op = legacy.manifest.actions[0]!;
    expect(capabilityInvocationBody(normalizeCapabilityCall("fixture", op, { input: body.input }))).toEqual({ input: body.input });
    expect(capabilityToolInputSchema(op)).toEqual(op.inputSchema);
    expect(op).not.toHaveProperty("target");
    expect(op).not.toHaveProperty("refs");
    expect(op).not.toHaveProperty("code");
    expect(
      await invokeCompiledCapability({
        compiled: legacy,
        kind: "action",
        localId: "move",
        input: body.input,
        expectedSchemaHash: op.schemaHash,
        context,
      }),
    ).toMatchObject({ ok: true });
  });

  test("startup rejects unknown types, lists and flat-field collisions", () => {
    const compile = (override: Partial<CapabilityActionDefinition>) =>
      compileCapabilities("fixture", { ...definitions, actions: { move: { ...action, ...override } } });
    expect(() => compile({ target: "missing" })).toThrow("declared type");
    expect(() => compile({ target: "foreign.book" })).toThrow("declared type");
    expect(() => compile({ refs: { targetBookId: "missing" } })).toThrow("declared type");
    expect(() => compile({ target: "contactId" })).toThrow();
    expect(() => compile({ refs: { targetBookId: "book", book: "book" } })).toThrow("collides");
    expect(() => compile({ refs: { contactId: "book" } })).toThrow("collides");
    expect(() => compile({ refs: { idempotencyKey: "book" } })).toThrow("collides");
    expect(() => compile({ input: z.object({ book: z.string().describe("Conflicting domain field.") }).strict() })).toThrow("collides");
  });

  test("manifests retain target, refs and code:false and bind them to schema/evolution hashes", () => {
    expect(parseCapabilityManifest(compiled.manifest, "fixture").actions[0]).toMatchObject({
      target: "book",
      refs: { targetBookId: "book" },
      code: false,
    });
    const changed = compileCapabilities("fixture", { ...definitions, actions: { move: { ...action, refs: {} } } }).manifest;
    expect(changed.actions[0]!.schemaHash).not.toBe(operation.schemaHash);
    expect(capabilityManifestEvolutionIssues(compiled.manifest, changed)).toContain("Action move changed its target contract");
  });

  test("fixed platform consumer contracts reject targets they cannot supply", () => {
    const query = {
      title: "Read",
      description: "Read a book.",
      input: z.object({ id: z.string().describe("Book ID.") }).strict(),
      data: z.object({}).strict(),
      openWorld: false,
      run: () => ({ ok: true as const, data: { data: {} } }),
    };
    expect(() =>
      compileCapabilities("fixture", {
        protocolVersion: 2,
        types: { book: { title: "Book", description: "A book.", reader: "read" } },
        queries: { read: { ...query, target: "book" } },
      }),
    ).toThrow("reader contract does not supply target");
    for (const special of [
      { data: CapabilityActionCheckSchema },
      { input: UniversalSearchInputSchema, data: UniversalSearchDataSchema, universalSearch: { tags: [] } },
    ])
      expect(() =>
        compileCapabilities("fixture", {
          protocolVersion: 2,
          types: definitions.types,
          queries: { read: { ...query, ...special, target: "book" } },
        }),
      ).toThrow("contracts do not supply target");
    expect(
      capabilityContractIssues({ kind: "action", input: action.input, data: action.data }, { kind: "action", operation }),
    ).toContainEqual({ code: "input", path: "$", message: "This consumer contract does not supply target or refs" });
  });
});
