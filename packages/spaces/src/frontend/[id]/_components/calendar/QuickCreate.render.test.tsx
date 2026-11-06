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

test("QuickCreate offers Template in its footer at a fixed width and reserves the template's line", () => {
  const html = renderToString(() =>
    createComponent(QuickCreate, {
      spaceId: "Space1",
      days: { first: "2026-10-14", last: "2026-10-14" },
      kind: "event",
      defaults: {},
      columnId: "Column1",
      templates: [],
      onCreateTemplate() {},
      onCreated() {},
      onMoreOptions() {},
    }),
  );
  // The footer's first control opens the templates; it keeps one width whatever it names.
  expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*class="[^"]*w-\[9\.5rem\]/);
  expect(html).toContain("Template");
  // The line that names what a template adds is there before any template is chosen, so choosing one moves nothing.
  expect(html).toMatch(/<p[^>]*min-h-\[1\.125rem\][^>]*data-spaces-quick-create-from/);
});

test("QuickCreate without templates or the right to make them shows no Template button", () => {
  const html = renderToString(() =>
    createComponent(QuickCreate, {
      spaceId: "Space1",
      days: { first: "2026-10-14", last: "2026-10-14" },
      kind: "task",
      defaults: {},
      columnId: "Column1",
      onCreated() {},
      onMoreOptions() {},
    }),
  );
  expect(html).not.toContain('aria-haspopup="menu"');
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
