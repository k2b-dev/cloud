import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "assistant-authoring-stop-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
// This compiler is process-wide: preserve island wrappers for the neighboring page tests.
Bun.plugin(plugin());
const { LocaleProvider } = await import("@k2b/ui");
const { default: AssistantAuthoringStop } = await import("./AssistantAuthoringStop");

// Independent expected text, including mixed receipts: a submitted version never means that every draft has one.
const states = [
  {
    name: "no draft",
    counts: [0, 0, 0, 0],
    saved: ["Es gibt noch keinen Entwurf.", "There is no draft yet."],
    tasks: [["Entwurf vorbereiten und prüfen"], ["Prepare and check the draft"]],
    done: [[], []],
  },
  {
    name: "unchecked and untested draft",
    counts: [1, 1, 1, 1],
    saved: ["Der Entwurf ist gesichert, aber noch keine Version.", "The draft is safe, but there is no version yet."],
    tasks: [
      ["Entwurf prüfen", "Mit Beispielen testen", "Version speichern"],
      ["Check the draft", "Test with examples", "Save a version"],
    ],
    done: [[], []],
  },
  {
    name: "checked draft",
    counts: [1, 0, 1, 1],
    saved: ["Der Entwurf ist gesichert, aber noch keine Version.", "The draft is safe, but there is no version yet."],
    tasks: [
      ["Mit Beispielen testen", "Version speichern"],
      ["Test with examples", "Save a version"],
    ],
    done: [["Entwurf geprüft"], ["Draft checked"]],
  },
  {
    name: "tested draft",
    counts: [1, 1, 0, 1],
    saved: ["Der Entwurf ist gesichert, aber noch keine Version.", "The draft is safe, but there is no version yet."],
    tasks: [
      ["Entwurf prüfen", "Version speichern"],
      ["Check the draft", "Save a version"],
    ],
    done: [["Mit Beispielen getestet"], ["Tested with examples"]],
  },
  {
    name: "checked and tested draft",
    counts: [1, 0, 0, 1],
    saved: ["Der Entwurf ist gesichert, aber noch keine Version.", "The draft is safe, but there is no version yet."],
    tasks: [["Version speichern"], ["Save a version"]],
    done: [
      ["Entwurf geprüft", "Mit Beispielen getestet"],
      ["Draft checked", "Tested with examples"],
    ],
  },
  {
    name: "submitted version",
    counts: [1, 0, 0, 0],
    saved: ["Die Version ist eingereicht.", "The version is submitted."],
    tasks: [["Gespeichertes Ergebnis ansehen"], ["Review the saved result"]],
    done: [[], []],
  },
  {
    name: "several drafts",
    counts: [2, 1, 2, 2],
    saved: ["Die Entwürfe sind gesichert, aber noch keine Versionen.", "The drafts are safe, but there are no versions yet."],
    tasks: [
      ["1 Entwurf prüfen", "2 Entwürfe mit Beispielen testen", "2 Versionen speichern"],
      ["Check 1 draft", "Test 2 drafts with examples", "Save 2 versions"],
    ],
    done: [[], []],
  },
  {
    name: "all submitted",
    counts: [2, 0, 0, 0],
    saved: ["Die Versionen sind eingereicht.", "The versions are submitted."],
    tasks: [["Gespeichertes Ergebnis ansehen"], ["Review the saved result"]],
    done: [[], []],
  },
  {
    name: "mixed with unchecked draft",
    counts: [2, 1, 1, 1],
    saved: [
      "1 Entwurf ist gesichert, aber noch ohne Version. 1 Version ist eingereicht.",
      "1 draft is safe, but has no version yet. 1 version is submitted.",
    ],
    tasks: [
      ["1 Entwurf prüfen", "1 Entwurf mit Beispielen testen", "1 Version speichern"],
      ["Check 1 draft", "Test 1 draft with examples", "Save 1 version"],
    ],
    done: [[], []],
  },
  {
    name: "mixed with ready draft",
    counts: [2, 0, 0, 1],
    saved: [
      "1 Entwurf ist gesichert, aber noch ohne Version. 1 Version ist eingereicht.",
      "1 draft is safe, but has no version yet. 1 version is submitted.",
    ],
    tasks: [["1 Version speichern"], ["Save 1 version"]],
    done: [[], []],
  },
  {
    name: "mixed with several open drafts",
    counts: [3, 0, 0, 2],
    saved: [
      "2 Entwürfe sind gesichert, aber noch ohne Versionen. 1 Version ist eingereicht.",
      "2 drafts are safe, but have no versions yet. 1 version is submitted.",
    ],
    tasks: [["2 Versionen speichern"], ["Save 2 versions"]],
    done: [[], []],
  },
  {
    name: "mixed with several submitted versions",
    counts: [3, 0, 0, 1],
    saved: [
      "1 Entwurf ist gesichert, aber noch ohne Version. 2 Versionen sind eingereicht.",
      "1 draft is safe, but has no version yet. 2 versions are submitted.",
    ],
    tasks: [["1 Version speichern"], ["Save 1 version"]],
    done: [[], []],
  },
] as const;

for (const [index, locale] of ["de", "en"].entries()) {
  const de = locale === "de";
  for (const reason of ["input_tokens", "model_calls", "repeated_error"] as const) {
    for (const fixture of states) {
      test(`${locale}: ${reason}, ${fixture.name} reports the exact saved state`, () => {
        const [drafts, unchecked, untested, unsubmitted] = fixture.counts;
        const state: AiCodeAuthoringStop = { reason, completedSteps: 3, drafts, unchecked, untested, unsubmitted };
        const html = renderToString(() =>
          createComponent(LocaleProvider, {
            locale,
            get children() {
              return createComponent(AssistantAuthoringStop, { state, continuable: () => false });
            },
          }),
        );
        const title = de ? "Gustav macht eine Pause" : "Gustav is taking a break";
        const explanation =
          reason === "repeated_error"
            ? de
              ? "Derselbe Fehler kam mehrmals. Er wartet jetzt auf dich."
              : "The same error came up several times. He is waiting for you now."
            : de
              ? "Er hat in diesem Schritt schon viel ausprobiert und wartet jetzt auf dich."
              : "He has already tried a lot in this step and is waiting for you now.";
        expect(html).toContain(`class="k2b-notice-card__title">${title}</p>`);
        expect(html).toContain(`class="k2b-notice-card__description">${explanation}</p>`);
        expect(html).toContain(fixture.saved[index]!);
        const rows = [...html.matchAll(/<li\b[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => ({
          status: match[1],
          text: /class="k2b-chat-task__content">([\s\S]*?)<\/span>/.exec(match[2]!)?.[1]?.replace(/<!--.*?-->/g, ""),
        }));
        expect(rows).toEqual([
          ...fixture.done[index]!.map((text) => ({ status: "completed", text })),
          ...fixture.tasks[index]!.map((text) => ({ status: "pending", text })),
        ]);
        expect(html).not.toMatch(/zu teuer|cost too much/);
        expect(html).toContain(de ? "Weiterarbeiten" : "Continue");
      });
    }
  }
}
