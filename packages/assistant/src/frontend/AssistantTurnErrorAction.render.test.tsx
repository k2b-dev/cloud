import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiStoredMessage, AiTurnError } from "@k2b/cloud/ai";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "assistant-model-remedy-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
const [{ default: AssistantTurnErrorAction }, { LocaleProvider, Chat }, { AiChatActionsProvider, createAiChatTimeline }] =
  await Promise.all([import("./AssistantTurnErrorAction"), import("@k2b/ui"), import("@k2b/cloud/ai/ui")]);
beforeAll(() => setSystemTime(new Date("2026-11-19T09:00:00.000Z")));
afterAll(() => setSystemTime());

for (const locale of ["de", "en"]) {
  for (const canConfigure of [false, true]) {
    for (const code of ["host_rejected", "host_budget_limit", "not_allowed"] as const) {
      test(`${locale}: ${code} offers model management only to an admin (${canConfigure})`, () => {
        const reason =
          locale === "de"
            ? "Die Administration kann den Preis in der Modellverwaltung eintragen."
            : "An administrator can enter the price in model management.";
        const error: AiTurnError = { code, message: reason };
        const history: AiStoredMessage[] = [
          {
            id: "message",
            shortId: "message",
            conversationId: "chat",
            seq: 1,
            kind: "message",
            message: { role: "user", content: [{ type: "text", text: "Morning briefing" }] },
            loopId: "turn",
            modelId: null,
            providerModel: null,
            usage: null,
            stopReason: null,
            loopAggregate: null,
            loopDoneReason: null,
            compactedAt: null,
            meta: { turnError: error },
            createdAt: "2026-11-19T09:00:00.000Z",
          },
        ];
        const html = renderToString(() =>
          createComponent(LocaleProvider, {
            locale,
            get children() {
              return createComponent(AiChatActionsProvider, {
                actions: {
                  renderTurnErrorAction: (failure) => createComponent(AssistantTurnErrorAction, { error: failure, canConfigure }),
                },
                get children() {
                  const items = createAiChatTimeline({ messages: () => history, activeTurn: () => null });
                  return createComponent(Chat.Timeline, {
                    get items() {
                      return items();
                    },
                  });
                },
              });
            },
          }),
        );
        const allowed = canConfigure && code === "host_rejected";
        expect(html.includes('href="/admin/ai?sec=providers"')).toBe(allowed);
        if (code.startsWith("host_")) expect(html).toContain(reason);
        if (allowed) expect(html).toContain(locale === "de" ? "Modellverwaltung" : "Model management");
      });
    }
  }
}
