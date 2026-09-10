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

const [{ LocaleProvider }, { default: AiSkillsAdminPanel }] = await Promise.all([import("@k2b/ui"), import("./AiSkillsAdminPanel.tsx")]);

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
            revision: 1,
            templateId: null,
            templateVersion: null,
            currentTemplateVersion: null,
            templateStatus: null,
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
            revision: 2,
            templateId: "core:skill-creator",
            templateVersion: 1,
            currentTemplateVersion: 2,
            templateStatus: "update_available",
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
    expect(html).toContain("No template linked");
    expect(html).toContain("core:skill-creator");
    expect(html).toContain("Update available");
    expect(html).toContain("Reset to current template");
    expect(html).toContain("Link to template");
    expect(html).not.toContain("Save changes");
  });
  test("renders template origin and all lifecycle states in the inherited German locale", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return createComponent(AiSkillsAdminPanel, {
            skills: (["current", "modified", "update_available"] as const).map((templateStatus, index) => ({
              id: `id-${index}`,
              shortId: `skl23${index}`,
              name: `test-${index}`,
              description: "Template workflow",
              revision: 3,
              templateId: `test:template-${index}`,
              templateVersion: 1,
              currentTemplateVersion: templateStatus === "update_available" ? 2 : 1,
              templateStatus,
              referenceCount: 1,
              accessCount: 1,
              adminCount: 1,
              createdAt: "2026-09-10T10:00:00Z",
              updatedAt: "2026-09-10T10:00:00Z",
            })),
            summary: { total: 3, unmanaged: 0, totalAccess: 3 },
            total: 3,
            page: 1,
            perPage: 100,
            search: "",
          });
        },
      }),
    );
    for (const text of ["KI-Skills", "Vorlage", "Aktuell", "Angepasst", "Update verfügbar", "Auf aktuelle Vorlage zurücksetzen"])
      expect(html).toContain(text);
    expect(html).not.toContain("Reset to current template");
  });
});
