import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiTurnBlock } from "@k2b/cloud/ai";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// The server renders a secret call from the stored block alone, as the first client frame does before any controller
// registers: the outcome line after a reload, and a quiet step while the call waits. Neither ever shows a value.

const root = mkdtempSync(resolve(tmpdir(), "assistant-secret-entry-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
registerSsrTestPlugin({ dev: true, rootDir: root });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const [
  { SecretRequestEntry },
  { SECRET_CARD_SCENES, SECRET_FIXTURE_VALUE, secretSceneArgs },
  { LocaleProvider },
  { createSecretTitleStore },
] = await Promise.all([import("./SecretRequestEntry"), import("./secret-card.fixture"), import("@k2b/ui"), import("./secret-title-store")]);
/** What the page's request loaded for the scenes' automation "Abc234". */
const LOADED = { Abc234: "Paketstatus abrufen" };

const html = (code: boolean, step: string, result: unknown, titles: Record<string, string | null> = LOADED) => {
  const store = createSecretTitleStore(titles);
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(SecretRequestEntry, {
          turnId: "turn",
          // A damaged stored block with a value in its arguments still shows only the public metadata.
          block: (): Extract<AiTurnBlock, { kind: "tool" }> => ({
            kind: "tool",
            id: "tool-call",
            callId: "call",
            name: "code_secret",
            status: step === "interaction" ? "awaiting_client" : "completed",
            args: { ...secretSceneArgs(code), value: SECRET_FIXTURE_VALUE },
            result,
            at: "2026-11-19T18:42:00.000Z",
          }),
          state: () => step as "interaction",
          conversationId: () => "chat",
          timeZone: "Europe/Berlin",
          titles: store,
        });
      },
    }),
  );
};
const words = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    // A tag boundary before punctuation is no space in the rendered line.
    .replace(/ ([:.,])/g, "$1")
    .trim();

test("every stored outcome renders its one line on the server, without the value", () => {
  const lines = SECRET_CARD_SCENES.filter((scene) => scene.step !== "interaction").map((scene) => [
    scene.id,
    words(html(scene.code, scene.step, scene.result)),
  ]);
  expect(Object.fromEntries(lines)).toEqual({
    gespeichert: "Secret Paketdienst-API gespeichert · 19:42",
    "b-ersetzt": "Secret Paketdienst-API gespeichert · 19:42",
    abgelehnt: "Secret Paketdienst-API abgelehnt · 19:42",
    "f-recht": "Secret Paketdienst-API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts. · 19:42",
    "f-chat-weg+":
      "Secret Paketdienst-API nicht gespeichert: Du kannst in diesem Chat nicht mehr schreiben, oder es gibt ihn nicht mehr. Gespeichert ist nichts. · 19:42",
    "c-anmeldung+": "Secret Paketdienst_API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts. · 19:42",
    abgelaufen: "Anfrage nach Secret Paketdienst-API nicht mehr offen. Gespeichert ist nichts. · 19:42",
    "c-gespeichert": "Secret Paketdienst_API gespeichert · 19:42",
    "c-ersetzt": "Secret Paketdienst_API gespeichert · 19:42",
    "c-abgelehnt": "Secret Paketdienst_API abgelehnt · 19:42",
    "c-recht":
      "Secret Paketdienst_API nicht gespeichert: Du darfst „Paketstatus abrufen“ nicht mehr bearbeiten, oder es gibt sie nicht mehr. Gespeichert ist nichts. · 19:42",
    "c-abgelaufen": "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts. · 19:42",
    "c-nicht-verwaltet": "",
    "c-ausgang-unklar+": "Secret Paketdienst_API: Keine Antwort von Cloud, vielleicht gespeichert. · 19:42",
  });
  for (const scene of SECRET_CARD_SCENES) expect(html(scene.code, scene.step, scene.result)).not.toContain(SECRET_FIXTURE_VALUE);
});

test("after a reload the lost-right line names the automation the page loaded; general words only when Core has none", () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "c-recht")!;
  expect(words(html(true, scene.step, scene.result))).toContain("Du darfst „Paketstatus abrufen“ nicht mehr bearbeiten");
  // Deleted, or the reader may no longer read it: Core answered, and the line says "the automation".
  expect(words(html(true, scene.step, scene.result, { Abc234: null }))).toContain("Du darfst die Automation nicht mehr bearbeiten");
  // Another automation's title never fills this line.
  expect(words(html(true, scene.step, scene.result, { Other1: "Andere" }))).toContain("Du darfst die Automation nicht mehr bearbeiten");
});

test("the time follows the sentence after a middle dot, as in the mockup", () => {
  const markup = html(false, "done", { configured: true, name: "Paketdienst-API" });
  expect(markup).toMatch(/class="k2b-chat-outcome__time"[^>]*>· 19:42</);
});

test("a waiting call renders the quiet step on the server, and a turn that ended before an answer says so", () => {
  expect(words(html(false, "interaction", undefined))).toBe("Secret Paketdienst-API");
  expect(html(false, "interaction", undefined)).not.toContain("k2b-chat-decision");
  expect(words(html(true, "not_run", undefined))).toBe(
    "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts. · 19:42",
  );
});
