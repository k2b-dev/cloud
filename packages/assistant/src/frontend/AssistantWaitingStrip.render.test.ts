import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { WAITING_NOW, waitingFixture, waitingStripSummary } from "./waiting-questions.fixture";

// The server renders "Waiting for you" from the same read the browser starts from. Its first client frame, in
// AssistantWorkspace.waiting.behavior.test.tsx, must show the same row: the same entries, and quiet in the same case.

const root = mkdtempSync(resolve(tmpdir(), "assistant-waiting-strip-"));
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

test("the server renders the waiting row of every case as the first client frame shows it", () => {
  const here = waitingFixture.conversations[0]!;
  for (const [name, fixture] of Object.entries(waitingFixture.cases)) {
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
              classes: [],
              visionModelConfigured: false,
              error: null,
              options: [],
            },
            models: [],
            timeZone: "Europe/Berlin",
            renderedAt: WAITING_NOW,
            initialLiveCursor: "s6t.cloud-live-core.0",
            initialConversations: waitingFixture.conversations,
            initialQuestions: fixture.questions,
            initialDoneCount: 0,
            initialConversationId: here.id,
            initialArtifactPath: null,
            initialDetail: { conversation: here, messages: [], hasMoreMessages: false, activeTurn: fixture.activeTurn, timeline: [] },
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
    expect([name, waitingStripSummary(html)]).toEqual([name, fixture.server]);
    // Chats with an open question carry the dot from the first paint, in the list and in the phone menu's data.
    if (name === "three") {
      expect(html.match(/<i class="assistant-chat-waiting"/g)?.length).toBe(2);
      expect(html.match(/"status":\{"icon":"assistant-chat-waiting"/g)?.length).toBe(2);
    }
  }
});
