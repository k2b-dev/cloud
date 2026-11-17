import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { authoringStopReasons, authoringStopSaves, authoringStopState } from "./authoring-stop.test-fixture";

// Use the same compiler as neighbouring page renders (#3632), including their island boundaries.
const root = mkdtempSync(join(tmpdir(), "assistant-authoring-stop-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
const [{ default: AssistantAuthoringStop }, { LocaleProvider }, { AiChatActionsProvider }] = await Promise.all([
  import("./AssistantAuthoringStop"),
  import("@k2b/ui"),
  import("@k2b/cloud/ai/ui"),
]);
const render = (locale: string, state: AiCodeAuthoringStop, available = true, blocked = false) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onContinueTurn: () => {}, actionDisabled: () => blocked },
          get children() {
            return createComponent(AssistantAuthoringStop, { state, continuable: () => available });
          },
        });
      },
    }),
  );

describe("the v10 pause receipt", () => {
  for (const locale of ["de", "en"] as const) {
    for (const reason of authoringStopReasons) {
      for (const save of authoringStopSaves) {
        test(`${locale}: ${reason} / ${save}`, () => {
          const html = render(locale, authoringStopState(reason, save));
          const de = locale === "de";
          const title = de ? "Gustav macht eine Pause." : "Gustav is taking a break.";
          const reasonText = de
            ? {
                input_tokens: "Arbeitspensum der Runde erreicht",
                model_calls: "Alle Schritte der Runde gemacht",
                repeated_error: "Derselbe Fehler kam mehrmals",
              }[reason]
            : {
                input_tokens: "This round’s work allowance is used up",
                model_calls: "All steps in this round are done",
                repeated_error: "The same error came up several times",
              }[reason];
          const saved = de
            ? { none: "Noch kein Entwurf", draft: "Entwurf gespeichert, noch keine Version", version: "Version gespeichert" }[save]
            : { none: "No draft yet", draft: "Draft saved, no version yet", version: "Version saved" }[save];
          expect(html).toContain(`data-tone="neutral"`);
          expect(html).toContain(title);
          if (reason === "repeated_error") expect(html).toContain(de ? "Ein Hinweis von dir hilft weiter." : "A hint from you will help.");
          expect(html).toContain(`${reasonText} · ${saved}`);
          expect(html.match(/ti-player-pause/g)).toHaveLength(1);
          expect(html).not.toContain("k2b-chat-task");
          expect(html).not.toMatch(/code_|\.tsx?\b|unchecked|unsubmitted|Version 2/);
          expect(html).toContain(`data-variant="primary"`);
        });
      }
    }
    test(`${locale}: a historical pause has no continuation action`, () => {
      const html = render(locale, authoringStopState("input_tokens", "version"), false);
      const button = html.match(/<button\b[^>]*>/)?.[0];
      expect(button).toContain(`aria-hidden="true"`);
      expect(button).toContain("disabled");
      expect(html).toContain("assistant-authoring-stop__retired");
      expect(html).toContain(locale === "de" ? "Version gespeichert" : "Version saved");
    });
    test(`${locale}: another operation explains the disabled action in the quiet line`, () => {
      const html = render(locale, authoringStopState("model_calls", "none"), true, true);
      expect(html).toContain(locale === "de" ? "Geht, sobald Gustav fertig ist." : "Available when Gustav is finished.");
      expect(html).toContain("disabled");
    });
  }
  for (const fixture of [
    { drafts: 2, unsubmitted: 2, de: "Entwürfe gespeichert, noch keine Versionen", en: "Drafts saved, no versions yet" },
    { drafts: 2, unsubmitted: 0, de: "Versionen gespeichert", en: "Versions saved" },
    {
      drafts: 2,
      unsubmitted: 1,
      de: "1 Entwurf ohne Version gespeichert, 1 Version gespeichert",
      en: "1 draft saved without a version, 1 version saved",
    },
    {
      drafts: 3,
      unsubmitted: 2,
      de: "2 Entwürfe ohne Version gespeichert, 1 Version gespeichert",
      en: "2 drafts saved without a version, 1 version saved",
    },
    {
      drafts: 3,
      unsubmitted: 1,
      de: "1 Entwurf ohne Version gespeichert, 2 Versionen gespeichert",
      en: "1 draft saved without a version, 2 versions saved",
    },
  ]) {
    for (const locale of ["de", "en"] as const) {
      test(`${locale}: ${fixture.drafts} drafts / ${fixture.unsubmitted} without a version retain the saved facts`, () => {
        const state = { ...authoringStopState("output_tokens", "draft"), drafts: fixture.drafts, unsubmitted: fixture.unsubmitted };
        expect(render(locale, state, false)).toContain(fixture[locale]);
      });
    }
  }
});
