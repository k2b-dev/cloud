import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// The composer's foot always holds the usage ring (v12 §9): "+", usage, model, dictation, send. A chat with nothing
// sent yet, such as the start page, shows it empty instead of leaving its place out (Rundgang 6, g01).

const root = mkdtempSync(resolve(tmpdir(), "assistant-composer-usage-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const [{ default: AssistantWorkspace }, { LocaleProvider }] = await Promise.all([import("./AssistantWorkspace.island"), import("@k2b/ui")]);

test("the start page's composer shows the usage ring, empty, in the foot", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AssistantWorkspace, {
          userId: "user01",
          cloudUrl: "http://localhost",
          status: {
            ok: true,
            enabled: true,
            status: "ok",
            selection: null,
            effectiveDefault: { class: "balanced" },
            classes: [{ class: "balanced", variantId: "standard" }],
            visionModelConfigured: false,
            error: null,
            options: [],
          },
          models: [
            {
              id: "standard",
              label: "Standard",
              description: "",
              icon: { kind: "mark", text: "AI", color: "0" },
              classes: ["balanced"],
              contextWindow: 128_000,
            },
          ],
          timeZone: "Europe/Berlin",
          renderedAt: "2026-11-16T09:00:00.000Z",
          initialLiveCursor: "s6t.cloud-live-core.0",
          initialConversations: [],
          initialQuestions: { items: [], count: 0 },
          // No budget is set up, as on the Preview: the ring stands for this chat's context alone.
          initialQuotas: { enabled: false, balances: [] },
          initialDoneCount: 0,
          initialConversationId: null,
          initialArtifactPath: null,
          initialDetail: null,
          initialContext: null,
          projects: [],
          initialProject: null,
          initialProjectChats: null,
          initialProjectContext: null,
          approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
        });
      },
    }),
  );
  const foot = /<footer class="k2b-chat-composer__footer"[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
  expect(foot).not.toBe("");
  expect(foot).toContain("k2b-chat-usage");
});
