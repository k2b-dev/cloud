import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

registerSsrTestPlugin({ dev: true, rootDir: process.cwd() });
const { prompts } = await import("@k2b/ui");
const { confirmAssistantArchive } = await import("./confirm-archive");

afterEach(() => mock.restore());

test.each([
  ["en", 0, 'Archive "Research"?'],
  ["en", 1, 'Archive "Research"?\n\n1 waiting message will be discarded.'],
  ["en", 2, 'Archive "Research"?\n\n2 waiting messages will be discarded.'],
  ["en", undefined, 'Archive "Research"?\n\nWaiting messages will be discarded.'],
  ["de", 0, "„Research“ archivieren?"],
  ["de", 1, "„Research“ archivieren?\n\n1 wartende Nachricht wird verworfen."],
  ["de", 2, "„Research“ archivieren?\n\n2 wartende Nachrichten werden verworfen."],
  ["de", undefined, "„Research“ archivieren?\n\nWartende Nachrichten werden verworfen."],
] as const)("archive confirmation uses %s with queue count %s", async (locale, count, expected) => {
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  expect(await confirmAssistantArchive({ id: "chat", title: "Research" }, locale, count)).toBe(false);
  expect(confirm.mock.calls[0]?.[0]).toBe(expected);
  expect(confirm.mock.calls[0]?.[1]).toMatchObject({ icon: "ti ti-archive", confirmText: locale === "de" ? "Archivieren" : "Archive" });
});
