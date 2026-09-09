import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { AiProject } from "@k2b/cloud/ai";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-empty-chat-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { default: AssistantEmptyChat, assistantStarterActions } = await import("./AssistantEmptyChat");

const project = {
  id: "project123",
  shortId: "project123",
  name: "Support",
  description: "Shared support context",
  icon: "ti ti-folders",
  instructions: "",
  defaultModelProfileId: null,
  permission: "read",
  revision: 1,
  createdAt: "2026-08-15T08:00:00.000Z",
  updatedAt: "2026-08-15T08:00:00.000Z",
} satisfies AiProject;

describe("Assistant empty chat", () => {
  test("centers one composer, a Project companion, and editable starter actions", () => {
    const html = renderToString(() =>
      createComponent(AssistantEmptyChat, {
        composer: "Shared composer",
        projects: [project],
        selectedProjectId: project.id,
        onChooseProject: () => undefined,
        onStarter: () => undefined,
      }),
    );

    expect(html).toContain("What should we work on?");
    expect(html).toContain("Shared composer");
    expect(html).toContain("Support");
    expect(html).toContain('aria-label="Choose a Project for this chat"');
    for (const starter of assistantStarterActions) {
      expect(html).toContain(starter.label);
      expect(starter.prompt.length).toBeGreaterThan(0);
    }
  });

  test("labels an unassigned chat honestly", () => {
    const html = renderToString(() =>
      createComponent(AssistantEmptyChat, {
        composer: "Shared composer",
        projects: [project],
        selectedProjectId: null,
        onChooseProject: () => undefined,
        onStarter: () => undefined,
      }),
    );

    expect(html).toContain("No Project");
    expect(html).toContain("ti ti-folder");
    expect(html).toContain("assistant-empty-project-trigger");
    expect(html).toContain('data-size="xs"');
    expect(html).toContain('data-variant="ghost"');
  });
});
