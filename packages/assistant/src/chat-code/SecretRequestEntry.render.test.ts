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

const [{ SecretRequestEntry }, { SECRET_CARD_SCENES, SECRET_FIXTURE_VALUE, secretSceneArgs }, { LocaleProvider }] = await Promise.all([
  import("./SecretRequestEntry"),
  import("./secret-card.fixture"),
  import("@k2b/ui"),
]);

const html = (code: boolean, step: string, result: unknown) =>
  renderToString(() =>
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
        });
      },
    }),
  );
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
    gespeichert: "Secret Paketdienst-API gespeichert 19:42",
    "b-ersetzt": "Secret Paketdienst-API gespeichert 19:42",
    abgelehnt: "Secret Paketdienst-API abgelehnt 19:42",
    "f-recht": "Secret Paketdienst-API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts. 19:42",
    abgelaufen: "Anfrage nach Secret Paketdienst-API nicht mehr offen. Gespeichert ist nichts. 19:42",
    "c-gespeichert": "Secret Paketdienst_API gespeichert 19:42",
    "c-ersetzt": "Secret Paketdienst_API gespeichert 19:42",
    "c-abgelehnt": "Secret Paketdienst_API abgelehnt 19:42",
    "c-recht":
      "Secret Paketdienst_API nicht gespeichert: Du darfst die Automation nicht mehr bearbeiten, oder es gibt sie nicht mehr. Gespeichert ist nichts. 19:42",
    "c-abgelaufen": "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts. 19:42",
    "c-nicht-verwaltet": "",
    "c-ausgang-unklar+": "Secret Paketdienst_API: Keine Antwort von Cloud, vielleicht gespeichert. 19:42",
  });
  for (const scene of SECRET_CARD_SCENES) expect(html(scene.code, scene.step, scene.result)).not.toContain(SECRET_FIXTURE_VALUE);
});

test("a waiting call renders the quiet step on the server, and a turn that ended before an answer says so", () => {
  expect(words(html(false, "interaction", undefined))).toBe("Secret Paketdienst-API");
  expect(html(false, "interaction", undefined)).not.toContain("k2b-chat-decision");
  expect(words(html(true, "not_run", undefined))).toBe(
    "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts. 19:42",
  );
});
