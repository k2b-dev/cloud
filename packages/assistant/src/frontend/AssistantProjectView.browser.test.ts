import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiConversation, AiConversationPage, AiProject } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../../ui/test/browser";

// Where the chat list's rows end next to its scroll track is a layout result of
// the shipped cascade, which happy-dom does not model. A real engine lays out
// the server's HTML.

const root = mkdtempSync(resolve(tmpdir(), "assistant-project-view-browser-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const [{ default: AssistantProjectView }, { AssistantLiveProvider, createAssistantLiveHub }] = await Promise.all([
  import("./AssistantProjectView"),
  import("./assistant-live"),
]);

const project = {
  id: "project123",
  shortId: "project123",
  name: "IT support",
  description: "",
  icon: "ti ti-folders",
  instructions: "",
  defaultModel: null,
  permission: "admin",
  revision: 1,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
} satisfies AiProject;
const chats = Array.from(
  { length: 12 },
  (_, index) =>
    ({
      id: `chat${index}`,
      shortId: `chat${index}`,
      title: `Printer issue ${index}`,
      description: "",
      projectId: project.id,
      updatedAt: "2026-08-12T09:00:00.000Z",
    }) as AiConversation,
);
const page = { items: chats, page: 1, perPage: 20, total: chats.length, hasNext: false } as AiConversationPage;
const empty = { items: [], page: 1, hasNext: false };

const html = renderToString(() =>
  createComponent(AssistantLiveProvider, {
    value: createAssistantLiveHub(),
    get children() {
      return createComponent(AssistantProjectView, {
        project,
        initialPage: page,
        initialContext: { projectId: project.id, apps: empty, skills: empty, knowledge: [], files: [], references: [] },
        onOpenConversation: async () => true,
        composer: "Composer",
      });
    },
  }),
);

let browser: Browser;
const stylesheets: Record<"track" | "overlay", string> = { track: "", overlay: "" };
beforeAll(async () => {
  // Cloud compiles app stylesheets; the Assistant reaches its Tailwind plugin through @k2b/cloud.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  // The page head's order: the app's stylesheet, then Cloud's global one.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")].map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  stylesheets.track = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  // Hiding the scrollbar emulates an overlay scrollbar that takes no width.
  stylesheets.overlay = `${stylesheets.track}\n.assistant-project-chats-scroll{scrollbar-width:none!important}`;
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

describe(`Assistant Project view in ${browserName}`, () => {
  test.each([
    [1280, "track"],
    [1280, "overlay"],
    [390, "track"],
    [390, "overlay"],
  ] as const)("at %i px with the %s scrollbar, chat rows end at the search header's edge", async (width, mode) => {
    const browserPage = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await browserPage.setContent(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${stylesheets[mode]}</style></head>` +
          `<body class="k2b-ui" style="margin:0;padding:1rem">${html}</body></html>`,
      );
      const layout = await browserPage.evaluate(() => {
        const header = document.querySelector('[aria-labelledby="project-chats-heading"] > header')!.getBoundingClientRect();
        const scroller = document.querySelector(".assistant-project-chats-scroll")!;
        const rows = Array.from(scroller.querySelectorAll(".k2b-progressive-row"), (row) => {
          const box = row.getBoundingClientRect();
          return { left: box.left - header.left, right: header.right - box.right };
        });
        return { rows, overflowing: scroller.scrollHeight > scroller.clientHeight };
      });
      expect(layout.overflowing).toBe(true);
      expect(layout.rows).toHaveLength(chats.length);
      expect(layout.rows.filter(({ left, right }) => left !== 0 || right !== 0)).toEqual([]);
    } finally {
      await browserPage.close();
    }
  });
});
