import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiConversation, AiConversationPage, AiProject } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-project-view-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const [{ default: AssistantProjectView }, { assistantContextCountTitle }, { AssistantLiveProvider, createAssistantLiveInvalidationHub }] =
  await Promise.all([import("./AssistantProjectView"), import("./AssistantContextContent"), import("./assistant-live")]);

const project = {
  id: "project123",
  shortId: "project123",
  name: "IT support",
  description: "",
  icon: "ti ti-folders",
  instructions: "Answer from the supplied runbooks.",
  defaultModelProfileId: null,
  permission: "admin",
  revision: 1,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
} satisfies AiProject;

const chat = {
  id: "chat123",
  shortId: "chat123",
  title: "Printer issue",
  description: "",
  projectId: project.id,
  updatedAt: "2026-08-12T09:00:00.000Z",
} as AiConversation;

const page = {
  items: [chat],
  page: 1,
  perPage: 20,
  total: 1,
  hasNext: false,
} as AiConversationPage;

const initialApps = {
  items: [
    { id: "appSSR1", title: "Project bank reconciliation", icon: "ti ti-app-window", published: true, canManage: true, linked: true },
  ],
  page: 1,
  hasNext: false,
};
const projectContext = {
  apps: initialApps,
  skills: {
    items: [
      {
        id: "skill123",
        shortId: "skill123",
        name: "project-skill",
        description: "Reconcile statements",
        permission: "read" as const,
        enabled: true,
        revision: 1,
        referenceCount: 0,
        createdAt: "",
        updatedAt: "",
      },
    ],
    page: 1,
    hasNext: false,
  },
  projectId: project.id,
  knowledge: [
    {
      id: "knowledge123",
      shortId: "knowledge123",
      projectId: project.id,
      title: "Printer runbook",
      content: "# Printer runbook",
      createdAt: "2026-08-12T08:00:00.000Z",
      updatedAt: "2026-08-12T08:00:00.000Z",
    },
  ],
  files: [
    {
      id: "image123",
      shortId: "image123",
      projectId: project.id,
      path: "printer.png",
      mediaType: "image/png",
      size: 42,
      updatedAt: "2026-08-12T08:00:00.000Z",
    },
    {
      id: "file123",
      shortId: "file123",
      projectId: project.id,
      path: "printer.txt",
      mediaType: "text/plain",
      size: 42,
      updatedAt: "2026-08-12T08:00:00.000Z",
    },
  ],
  references: [
    {
      id: "reference123",
      shortId: "reference123",
      projectId: project.id,
      ref: { type: "spaces.item", id: "item123" },
      label: "Printer incident",
      createdAt: "2026-08-12T08:00:00.000Z",
    },
  ],
};

describe("Assistant Project view", () => {
  test("places compact recent chats above the bottom composer and renders a quiet context rail", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantProjectView, {
            project,
            initialPage: page,
            initialContext: {
              apps: initialApps,
              skills: {
                items: [
                  {
                    id: "skill123",
                    shortId: "skill123",
                    name: "project-skill",
                    description: "Reconcile statements",
                    permission: "read" as const,
                    enabled: true,
                    revision: 1,
                    referenceCount: 0,
                    createdAt: "",
                    updatedAt: "",
                  },
                ],
                page: 1,
                hasNext: false,
              },
              projectId: project.id,
              knowledge: [],
              files: [],
              references: [
                {
                  id: "mail-ref",
                  shortId: "MaR123",
                  projectId: project.id,
                  ref: { type: "mail.conversation", id: "MaL123" },
                  label: "Supplier invoice September",
                  createdAt: "2026-09-15T10:00:00.000Z",
                },
              ],
            },
            onOpenConversation: async () => true,
            get composer() {
              return "Standard composer";
            },
          });
        },
      }),
    );
    live.dispose();

    expect(html).toContain("IT support");
    expect(html).toContain("Standard composer");
    expect(html).toContain('data-scroll-preserve="assistant-project-chats"');
    expect(html).toContain("Printer issue");
    expect(html).toContain('aria-label="Search chats in IT support"');
    expect(html).not.toContain('aria-label="Search Project chats"');
    expect(html.indexOf("Printer issue")).toBeLessThan(html.indexOf("Standard composer"));
    expect(html).not.toContain("k2b-paper");
    expect(html).not.toContain("divide-y");
    expect(html).toContain("Project context");
    expect(html).toContain("View project");
    expect(html).toContain("Studio Apps");
    expect(html).toContain("Project bank reconciliation");
    expect(html).toContain("project-skill");
    expect(html).not.toContain("Loading Studio Apps");
    expect(html).toContain('aria-label="Link a Studio App"');
    expect(html).toContain('class="ti ti-eye"');
    expect(html).toContain("IT support");
    expect(html).toContain("text-[var(--ui-app-accent-text)]");
    expect(html).not.toContain(">Project instructions</h2>");
    expect(html).toContain("k2b-detail-panel__action");
    expect(html).toContain("Project knowledge");
    expect(html).toContain("Images");
    expect(html).toContain("Reference");
    expect(html).toContain("Supplier invoice September");
    expect(html).not.toContain(">Mail conversation<");
    expect(html).not.toContain('aria-expanded="true"');
    expect(html.match(/aria-label="Project settings"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Add Project knowledge"');
    expect(html).toContain('aria-label="Add reference"');
    expect(html).toContain("Add files");
    expect(html).not.toContain("admin access");
  });

  test("puts non-zero file counts into the section title", () => {
    expect(assistantContextCountTitle(0, "Image", "Images")).toBe("Images");
    expect(assistantContextCountTitle(1, "Image", "Images")).toBe("1 Image");
    expect(assistantContextCountTitle(3, "Image", "Images")).toBe("3 Images");
  });

  test("uses one item action menu for Project context management", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantProjectView, {
            project,
            initialPage: page,
            initialContext: projectContext,
            onOpenConversation: async () => true,
            get composer() {
              return "Standard composer";
            },
          });
        },
      }),
    );
    live.dispose();

    expect(html).toContain('aria-label="Actions for Printer runbook"');
    expect(html).toContain('aria-label="Actions for printer.png"');
    expect(html).toContain('aria-label="Actions for printer.txt"');
    expect(html).toContain('aria-label="Actions for Printer incident"');
    expect(html).toContain("1 Image");
    expect(html).toContain("1 File");
    expect(html).toContain("1 Reference");
    expect(html).not.toContain(">View all<");
    expect(html).not.toContain('aria-label="Edit Printer runbook"');
    expect(html).not.toContain('aria-label="Delete Printer runbook"');
  });

  test("adds View all as the last action only when a section overflows", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantProjectView, {
            project,
            initialPage: page,
            initialContext: {
              ...projectContext,
              files: [
                ...projectContext.files,
                {
                  ...projectContext.files[0]!,
                  id: "image456",
                  shortId: "image456",
                  path: "printer-detail.png",
                },
              ],
            },
            onOpenConversation: async () => true,
            get composer() {
              return "Standard composer";
            },
          });
        },
      }),
    );
    live.dispose();

    expect(html).toContain("2 Images");
    expect(html).toContain('class="ti ti-eye"');
    expect(html.match(/>View all</g)).toHaveLength(1);
    expect(html.indexOf("printer.png")).toBeLessThan(html.indexOf("View all"));
  });

  test("keeps Project context management out of a read-only workspace", () => {
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const html = renderToString(() =>
      createComponent(AssistantLiveProvider, {
        value: live,
        get children() {
          return createComponent(AssistantProjectView, {
            project: { ...project, permission: "read" },
            initialPage: page,
            initialContext: projectContext,
            onOpenConversation: async () => true,
            get composer() {
              return "Standard composer";
            },
          });
        },
      }),
    );
    live.dispose();

    expect(html).not.toContain('aria-label="Project settings"');
    expect(html).not.toContain('aria-label="Add Project knowledge"');
    expect(html).not.toContain('aria-label="Add images"');
    expect(html).not.toContain('aria-label="Add files"');
    expect(html).not.toContain('aria-label="Add reference"');
    expect(html).not.toContain('aria-label="Actions for Printer runbook"');
    expect(html).not.toContain('aria-label="Actions for Printer incident"');
    expect(html).toContain('aria-label="Actions for printer.png"');
    expect(html).toContain('aria-label="Actions for printer.txt"');
  });
});
