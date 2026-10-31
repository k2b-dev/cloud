import { expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { defineCapabilities } from "../../packages/cloud/src/contracts/capabilities";
import { capabilityTargetGaps } from "./capability-targets";

test("reports an intentionally wrong Action and allows declared targets and app-wide Actions", () => {
  const action = {
    title: "Rename",
    description: "Rename one item.",
    input: z.object({ itemId: z.string().describe("Stable item ID.") }).strict(),
    data: z.object({}).strict(),
    destructive: false,
    openWorld: false,
    idempotency: "none" as const,
    run: () => ({ ok: true as const, data: { data: {} } }),
  };
  const manifest = compileCapabilities(
    "fixture",
    defineCapabilities({
      protocolVersion: 2,
      types: { folder: { title: "Folder", description: "A folder." } },
      actions: {
        wrong: action,
        correct: { ...action, target: "folder" },
        create: { ...action, input: z.object({ title: z.string().describe("New folder name.") }).strict() },
        nested: {
          ...action,
          input: z.object({ child: z.object({ resource_id: z.string().describe("Resource ID.") }).describe("Resource.") }).strict(),
        },
        batch: {
          ...action,
          input: z.object({ children: z.array(z.object({ itemId: z.string().describe("Resource ID.") })).describe("Children.") }).strict(),
        },
        union: {
          ...action,
          input: z
            .object({ child: z.union([z.object({ itemId: z.string().describe("Resource ID.") }), z.null()]).describe("Child.") })
            .strict(),
        },
      },
    }),
  ).manifest;
  expect(capabilityTargetGaps(manifest)).toEqual([
    "fixture.batch: children[].itemId",
    "fixture.nested: child.resource_id",
    "fixture.union: child.itemId",
    "fixture.wrong: itemId",
  ]);
});
