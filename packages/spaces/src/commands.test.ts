import { SpaceInvitationInputSchema } from "./commands";
import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { SpaceComposeInputSchema } from "./commands";

test("Spaces Commands accept an empty form or bounded source reference, never copied message bodies", () => {
  const manifest = compileCapabilityManifest("spaces", {
    protocolVersion: 2,
    commands: {
      compose: { title: "New task", description: "Open a task form.", input: SpaceComposeInputSchema, path: "/app/spaces" },
    },
  });
  expect(manifest.commands).toHaveLength(1);
  expect(SpaceComposeInputSchema.parse({})).toEqual({});
  expect(SpaceComposeInputSchema.parse({ source: { type: "mail.conversation", id: "AbCd12" } }).source?.id).toBe("AbCd12");
  expect(SpaceComposeInputSchema.safeParse({ body: "mail contents" }).success).toBe(false);
});

test("calendar Commands require an existing resource and reject arbitrary payloads", () => {
  expect(SpaceInvitationInputSchema.safeParse({}).success).toBe(false);
  expect(SpaceInvitationInputSchema.safeParse({ itemId: "Event1", method: "cancel" }).success).toBe(true);
  expect(SpaceInvitationInputSchema.safeParse({ ...{ itemId: "Event1", method: "cancel" }, body: "private mail" }).success).toBe(false);
});
