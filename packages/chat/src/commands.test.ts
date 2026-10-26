import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { chatCapabilities } from "./capabilities";
import { ChatComposeInputSchema } from "./commands";

const userId = "22222222-2222-4222-8222-222222222222";

test("Chat's command accepts exactly one user UUID, without caller-supplied names or authority", () => {
  expect(ChatComposeInputSchema.parse({ userId })).toEqual({ userId });
  for (const input of [{}, { userId: "Nora" }, { userId: "" }, { userId, name: "Forged name" }, { userId, source: "filesv2" }]) {
    expect(ChatComposeInputSchema.safeParse(input).success).toBe(false);
  }
});

test("Chat publishes a localized, non-mutating command owned by its workspace", () => {
  const manifest = compileCapabilityManifest("chat", chatCapabilities);
  expect(manifest.commands).toHaveLength(1);
  expect(manifest.commands[0]).toMatchObject({ localId: "conversation.compose", path: "/app/chat" });
  expect(manifest.actions).toEqual([]);
});
