import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-quick-create-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
beforeEach(() => setSystemTime(new Date("2026-10-24T12:00:00Z")));
afterEach(() => setSystemTime());

const { default: QuickCreate, quickCreateDefaults } = await import("./QuickCreate");

test("QuickCreate renders shared Enter and Escape caps inside its decorative hint", () => {
  const html = renderToString(() =>
    createComponent(QuickCreate, {
      spaceId: "Space1",
      days: { first: "2026-10-14", last: "2026-10-14" },
      kind: "event",
      defaults: {},
      columnId: "Column1",
      onCreated() {},
      onMoreOptions() {},
    }),
  );
  expect(html.match(/class="k2b-kbd"/g)).toHaveLength(2);
  expect(html).toContain('<kbd class="k2b-kbd__key">↵</kbd>');
  expect(html).toContain('<kbd class="k2b-kbd__key">Esc</kbd>');
  expect(html).toMatch(/<span[^>]+aria-hidden="true"[^>]*>.*k2b-kbd/s);
});

test("quick create uses the last selected date without a slot, and the slot instant with a slot", () => {
  const days = { first: "2026-10-24", last: "2026-10-26" };
  for (const timeZone of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Kiritimati"]) {
    expect(quickCreateDefaults("task", days, { timeZone })).toEqual({ type: "task", deadline: "2026-10-26" });
    expect(quickCreateDefaults("task", days, { timeZone }, { start: "2026-10-24T10:00:00Z", end: "2026-10-24T11:00:00Z" })).toEqual({
      type: "task",
      deadline: "2026-10-24T10:00:00Z",
    });
  }
});
