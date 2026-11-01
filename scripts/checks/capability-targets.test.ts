import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { defineCapabilities } from "../../packages/cloud/src/contracts/capabilities";
import { capabilityTargetGaps, rule } from "./capability-targets";

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

test("reviewed input exceptions require code:false and exempt only the named field", () => {
  const action = {
    title: "Forget",
    description: "Forget one offline application.",
    input: z.object({ appId: z.string().describe("Offline application ID.") }).strict(),
    data: z.object({}).strict(),
    destructive: false,
    openWorld: false,
    idempotency: "none" as const,
    run: () => ({ ok: true as const, data: { data: {} } }),
  };
  const manifest = (definition: typeof action & { code?: false }) =>
    compileCapabilities("gateway-ops", defineCapabilities({ protocolVersion: 2, actions: { "app-status.forget": definition } })).manifest;
  expect(capabilityTargetGaps(manifest(action))).toEqual(["gateway-ops.app-status.forget: appId"]);
  expect(capabilityTargetGaps(manifest({ ...action, code: false }))).toEqual([]);
  expect(
    capabilityTargetGaps(
      manifest({
        ...action,
        code: false,
        input: action.input.extend({ itemId: z.string().describe("Another resource.") }),
      }),
    ),
  ).toEqual(["gateway-ops.app-status.forget: itemId"]);
  const policy = compileCapabilities(
    "core",
    defineCapabilities({
      protocolVersion: 2,
      actions: {
        "code.policy.update": {
          ...action,
          code: false,
          input: z
            .object({
              definition: z
                .object({
                  rules: z
                    .array(
                      z.object({
                        groupId: z.string().nullable().describe("Rule group selector."),
                      }),
                    )
                    .describe("Policy rows."),
                })
                .describe("Installation policy."),
            })
            .strict(),
        },
      },
    }),
  ).manifest;
  expect(capabilityTargetGaps(policy)).toEqual([]);
  const foreign = compileCapabilities(
    "chat",
    defineCapabilities({
      protocolVersion: 2,
      actions: {
        "discussion.post": {
          ...action,
          code: false,
          input: z
            .object({
              ref: z
                .object({ type: z.string().describe("Foreign resource Type."), id: z.string().describe("Foreign resource ID.") })
                .describe("Foreign item."),
            })
            .strict(),
        },
      },
    }),
  ).manifest;
  expect(capabilityTargetGaps(foreign)).toEqual([]);
  expect(capabilityTargetGaps({ ...foreign, appId: "other" })).toEqual(["other.discussion.post: ref.id"]);
});

test("the rule fails an intentionally wrong repository without an enforcement flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-target-rule-"));
  try {
    const src = join(root, "packages", "fixture", "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/fixture"] } }));
    await writeFile(join(src, "index.ts"), 'import { capabilities } from "./capabilities";\nconst app = { capabilities: capabilities };');
    // Use the installed schema library while keeping the fixture workspace disposable.
    await writeFile(
      join(src, "capabilities.ts"),
      `
      import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
      export const capabilities = {
        protocolVersion: 2,
        actions: { wrong: {
          title: "Wrong", description: "An Action missing its target.",
          input: z.object({ itemId: z.string().describe("Item ID.") }).strict(),
          data: z.object({}).strict(),
          destructive: false, openWorld: false, idempotency: "none",
          run: () => ({ ok: true, data: { data: {} } }),
        } },
      };
    `,
    );
    expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toEqual([
      { file: join(src, "capabilities.ts"), message: "Action needs a target: fixture.wrong: itemId" },
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("platform-generated Code access Actions keep their reserved dynamic input contract", () => {
  const manifest = compileCapabilities(
    "third-party",
    defineCapabilities({
      protocolVersion: 2,
      code: {
        access: {
          app: {
            manages: () => true,
            grant: () => ({ granted: true as const, level: "write" }),
            revoke: () => true,
            list: () => [],
          },
        },
      },
    }),
  ).manifest;
  expect(manifest.actions.map((action) => action.localId)).toEqual(["code.access.rm", "code.access.set"]);
  expect(capabilityTargetGaps(manifest)).toEqual([]);
});

test("foreign calendar response correlation is a field-specific code:false exception", () => {
  const action = {
    title: "Record response",
    description: "Correlate a foreign Mail draft.",
    input: z
      .object({
        mailboxId: z.string().describe("Foreign mailbox ID."),
        messageId: z.string().describe("Foreign message ID."),
        draftId: z.string().describe("Foreign draft ID."),
      })
      .strict(),
    data: z.object({}).strict(),
    destructive: false,
    openWorld: false,
    idempotency: "none" as const,
    run: () => ({ ok: true as const, data: { data: {} } }),
  };
  const manifest = (code?: false) =>
    compileCapabilities(
      "spaces",
      defineCapabilities({
        protocolVersion: 2,
        actions: { "calendar-invitation.response.commit": { ...action, ...(code === false ? { code } : {}) } },
      }),
    ).manifest;
  expect(capabilityTargetGaps(manifest(false))).toEqual([]);
  expect(capabilityTargetGaps(manifest())).toEqual(["spaces.calendar-invitation.response.commit: mailboxId, messageId, draftId"]);
});
