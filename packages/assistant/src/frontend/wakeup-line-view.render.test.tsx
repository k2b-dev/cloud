import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiWakeup } from "@k2b/cloud/ai";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { describeWakeupLine } from "./wakeup-line";

const root = mkdtempSync(resolve(tmpdir(), "assistant-wakeup-line-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
registerSsrTestPlugin({ dev: true, rootDir: root });
beforeAll(() => setSystemTime(new Date("2026-11-16T09:00:00.000Z")));
afterAll(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { AssistantWakeupLine } = await import("./wakeup-line-view");
const host = { act: () => undefined, retry: () => undefined };
const wakeup: AiWakeup = {
  id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
  at: "2026-11-16T15:00:00.000Z",
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note: "Antwort von Lena Vogt prüfen",
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 0,
  rhythm: "Einmalig",
};
const draw = (deleted: boolean, current: AiWakeup[]) =>
  renderToString(() =>
    createComponent(AssistantWakeupLine, {
      host,
      line: describeWakeupLine(
        { plan: { event: { id: "e", kind: "created", at: "2026-11-16T09:00:00.000Z", wakeup }, latest: true, deleted } },
        { locale: "de", timeZone: "Europe/Berlin", current },
      ),
    }),
  );

test("a set alarm is one line without a box: plum sign, words, and pencil and cross named for screen readers", () => {
  const html = draw(false, [wakeup]);
  expect(html).toContain('class="assistant-wakeup-line__sign ti ti-alarm"');
  expect(html.replace(/<[^>]*>/g, "")).toContain("Wecker · heute 16:00 · Antwort von Lena Vogt prüfen");
  expect(html).toContain('aria-label="Wecker ändern"');
  expect(html).toContain('aria-label="Wecker löschen"');
  expect(html).toContain("k2b-progressive-action");
});

test("a deleted alarm stays as a struck line with the word Deleted and no actions", () => {
  const html = draw(true, []);
  expect(html).toContain("data-struck");
  expect(html).toContain(">Gelöscht<");
  expect(html).not.toContain("Wecker ändern");
});

test("until its words load, a line keeps its place without text", () => {
  const html = renderToString(() => createComponent(AssistantWakeupLine, { host, line: undefined }));
  expect(html).toContain('class="assistant-wakeup-line k2b-progressive-row"');
  expect(html).not.toContain("Wecker");
});
