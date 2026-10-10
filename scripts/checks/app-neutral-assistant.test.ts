import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { appIdBranches, rule } from "./app-neutral-assistant";

test("reports comparisons, switches, lookups, and patterns on app ids, names, and tool names", () => {
  const lines = (source: string) => appIdBranches("chat.tsx", source).map((branch) => branch.line);
  expect(
    lines(
      [
        'if (block.presentation.appId === "mail") label = "Send";',
        'const own = "spaces" !== presentation?.appId;',
        "switch (entry.appId) { default: break; }",
        'if (["mail", "spaces"].includes(appId)) return;',
        'if (appId.startsWith("files")) return;',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5]);
  // The same branch spelled another way: a constant, a set, a lookup object, the app name, a pattern, or a tool name.
  expect(
    lines(
      [
        "if (appId === MAIL_APP_ID) return;",
        'if (new Set(["mail"]).has(appId)) return;',
        'const label = ({ mail: "Send" })[presentation.appId];',
        'if (presentation.appName === "Mail") return;',
        "if (/^mail$/.test(appId)) return;",
        'if (presentation["appId"] === "mail") return;',
        'if (block.name.startsWith("mail__")) return;',
        'if (name === "mail__action__draft_dot_send") return;',
        "if (BUILT_IN_APPS.has(appId)) return;",
        "switch (presentation.appName) { default: break; }",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Looking an app up by its id, or labelling a value with it, treats every app the same.
  expect(
    lines(
      [
        "const app = apps.find((candidate) => candidate.appId === appId);",
        'const scope = { appId: "assistant", tag: "chat" };',
        "const meta = text(tool.appId) || text(tool.kind);",
        "const owner = presentation?.appName ?? t().assistant;",
        "const icon = icons.get(appId);",
        'if (block.name === "code_run") return;',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("checks only Assistant presentation code and skips tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-app-neutral-"));
  try {
    const write = async (path: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'export const mail = (appId: string) => appId === "mail";\n');
    };
    await write("packages/cloud/src/ai/chat/receipt.tsx");
    await write("packages/cloud/src/ai/chat/receipt.test.tsx");
    await write("packages/assistant/src/cli/actions.ts");
    await write("packages/mail/src/capabilities.ts");
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`)).toEqual([
      "packages/assistant/src/cli/actions.ts:1",
      "packages/cloud/src/ai/chat/receipt.tsx:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
