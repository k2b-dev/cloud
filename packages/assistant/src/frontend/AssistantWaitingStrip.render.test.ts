import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { WAITING_NOW, waitingChatHistory, waitingFixture, waitingStripSummary } from "./waiting-questions.fixture";

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
            initialDetail: {
              conversation: here,
              messages: waitingChatHistory,
              hasMoreMessages: false,
              activeTurn: fixture.activeTurn,
              timeline: [],
            },
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
    // Chats with an open question carry the dot from the first paint, in the list, the collapsed rail's chat menu, and
    // the phone menu's data.
    if (name === "three") {
      expect(html.match(/<span class="assistant-chat-marker" data-tone="attention"[^>]*><i class="assistant-chat-waiting"/g)?.length).toBe(
        2,
      );
      expect(html.match(/<i class="assistant-chat-waiting"/g)?.length).toBe(4);
      expect(html.match(/"status":\{"icon":"assistant-chat-waiting"/g)?.length).toBe(2);
    }
  }
});

test("Code waiting kinds keep their own sign in the shared chip row", async () => {
  const { AssistantWaitingStrip } = await import("./AssistantWaitingStrip");
  const signs = {
    code_activate: "ti ti-power",
    code_changes: "ti ti-message-2",
    code_expired: "ti ti-clock-off",
    code_attention: "ti ti-alert-circle",
  } as const;
  for (const kind of ["code_activate", "code_changes", "code_expired", "code_attention"] as const) {
    const icon = signs[kind];
    const question: AiOpenQuestion = { ...waitingFixture.questions.items[0]!, kind };
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(AssistantWaitingStrip, {
            view: { attention: [], entries: [question], total: 1, more: 0, onlyHere: null },
            conversationId: question.conversationId,
            quiet: false,
            onJump: () => {},
            onShowMore: () => {},
          });
        },
      }),
    );
    expect(html).toContain(`data-kind="${kind}"`);
    expect(html).toContain(`assistant-waiting__icon ${icon}`);
  }
});

test("a Code entry shows the sign of its kind and its own sentence, never the approval prefix", async () => {
  const { AssistantWaitingStrip } = await import("./AssistantWaitingStrip");
  const base = waitingFixture.conversations[0]!;
  const question = {
    id: "q-code",
    kind: "code_activate" as const,
    conversationId: base.id,
    conversationTitle: base.title,
    anchor: "code-version-66666666-6666-4666-8666-666666666666",
    short: "Version 5 einschalten",
    createdAt: WAITING_NOW,
  };
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AssistantWaitingStrip, {
          view: { attention: [], entries: [question] as never, more: 0, total: 1, onlyHere: null },
          conversationId: base.id,
          quiet: false,
          onJump: () => undefined,
          onShowMore: () => undefined,
        });
      },
    }),
  );
  expect(html).toContain("ti-power");
  expect(html).toContain("Version 5 einschalten");
  expect(html).not.toContain("Freigabe:");
});
