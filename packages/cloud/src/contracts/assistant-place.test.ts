import { expect, test } from "bun:test";
import { z } from "zod";
import { createAssistantPlaceFixture, PLACE_FIXTURE_APP_ID } from "../../../../scripts/fixtures/assistant-place";
import { compileCapabilityManifest } from "../capabilities/testing";
import { AssistantPlaceSchema, assertAssistantPlaceSkills, assistantPlaceIssues } from "./assistant-place";
import type { CapabilityDefinitions } from "./capabilities";

const compile = (definitions: CapabilityDefinitions) => compileCapabilityManifest(PLACE_FIXTURE_APP_ID, definitions);

test("publishes the place contract and validates same-app target and bounded data", () => {
  const fixture = createAssistantPlaceFixture();
  const manifest = compile(fixture.capabilities);
  expect(manifest.types[0]?.assistant).toEqual(fixture.capabilities.types.conversation.assistant);
  expect(assistantPlaceIssues(manifest)).toEqual([]);
  expect(() => assertAssistantPlaceSkills(manifest, fixture.skillNames)).not.toThrow();
  expect(() => assertAssistantPlaceSkills(manifest, new Set())).toThrow("contact-writing");
});

test("rejects invalid assistant declarations at the startup compilation seam", () => {
  const { capabilities: valid } = createAssistantPlaceFixture();
  const type = valid.types.conversation;
  const provider = valid.queries["conversation.assistant"];
  const action = valid.actions["reply.set"];
  const invalid: CapabilityDefinitions[] = [
    { ...valid, types: { conversation: { ...type, reader: undefined } } },
    { ...valid, types: { conversation: { ...type, assistant: { ...type.assistant, provider: "missing.query" } } } },
    { ...valid, queries: { ...valid.queries, "conversation.assistant": { ...provider, target: undefined } } },
    { ...valid, queries: { ...valid.queries, "conversation.assistant": { ...provider, data: z.object({ title: z.string() }) } } },
    { ...valid, types: { conversation: { ...type, assistant: { ...type.assistant, tools: ["missing.action"] } } } },
    { ...valid, actions: { ...valid.actions, "reply.set": { ...action, target: undefined } } },
    { ...valid, actions: { ...valid.actions, "reply.set": { ...action, destructive: true } } },
    { ...valid, actions: { ...valid.actions, "reply.set": { ...action, openWorld: true } } },
  ];
  for (const declaration of invalid) expect(() => compile(declaration)).toThrow();
});

test("place payload rejects oversized context, lists, starters and unknown fields", () => {
  const valid = { title: "Marta Example", context: "Customer text", tools: [], skills: [] };
  expect(AssistantPlaceSchema.parse(valid)).toEqual(valid);
  for (const patch of [
    { title: "" },
    { title: "x".repeat(201) },
    { context: "x".repeat(32769) },
    { tools: Array(17).fill("reply.set") },
    { skills: Array(9).fill("contact-writing") },
    { starters: Array(4).fill({ label: "Ask", prompt: "Question" }) },
    { starters: [{ label: "x".repeat(81), prompt: "Question" }] },
    { starters: [{ label: "Ask", prompt: "x".repeat(501) }] },
    { instructions: "not a contract field" },
  ])
    expect(AssistantPlaceSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
});
