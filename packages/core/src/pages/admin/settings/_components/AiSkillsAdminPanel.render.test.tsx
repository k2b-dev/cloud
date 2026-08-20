import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-ai-skills-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: AiSkillsAdminPanel } = await import("./AiSkillsAdminPanel.tsx");

describe("AiSkillsAdminPanel", () => {
  test("renders every Skill as a normal permission-owned recovery record", () => {
    const html = renderToString(() =>
      createComponent(AiSkillsAdminPanel, {
        skills: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "sKl234",
            name: "orphaned-skill",
            description: "A shared Skill without an administrator.",
            referenceCount: 0,
            accessCount: 0,
            adminCount: 0,
            createdAt: "2026-08-21T10:00:00.000Z",
            updatedAt: "2026-08-21T10:00:00.000Z",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            shortId: "mNg234",
            name: "skill-creator",
            description: "Create Skills.",
            referenceCount: 0,
            accessCount: 1,
            adminCount: 0,
            createdAt: "2026-08-21T10:00:00.000Z",
            updatedAt: "2026-08-21T10:00:00.000Z",
          },
        ],
        summary: { total: 2, unmanaged: 2, totalAccess: 1 },
        total: 2,
        page: 1,
        perPage: 100,
        search: "",
      }),
    );

    expect(html).toContain("AI Skills");
    expect(html).toContain("Without admins");
    expect(html).toContain("recovery required");
    expect(html).toContain("No admins");
    expect(html).toContain("Actions for orphaned-skill");
    expect(html).toContain("Actions for skill-creator");
    expect(html).toContain("Delete Skill");
    expect(html).not.toContain("Save changes");
  });
});
