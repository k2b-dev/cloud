import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { CodeAutomation, CodeSummary } from "../code-summary";

const root = mkdtempSync(join(tmpdir(), "assistant-code-titles-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

beforeAll(() => setSystemTime(new Date("2026-11-01T12:00:00.000Z")));
afterAll(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
});
const [{ default: CodeView }, { default: CodeBlock }, { automationTiming }, { LocaleProvider }] = await Promise.all([
  import("./AssistantCodeView"),
  import("./AssistantCodeBlock"),
  import("./automation-timing"),
  import("@k2b/ui"),
]);
const automation = (title?: string): CodeAutomation => ({
  entrypoint: "lieferungenEintragen",
  ...(title ? { title } : {}),
  kind: "manual",
  cron: null,
  nextRunAt: null,
  lastRun: null,
  missingTargets: [],
});
const code = (title?: string): CodeSummary => ({
  id: "c_titles",
  title: "Logistik",
  state: "active",
  lastRun: null,
  automations: [automation(title)],
});
const render = (surface: "apps" | "panel", title?: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        const page = { items: [code(title)], nextCursor: null };
        return surface === "apps"
          ? createComponent(CodeView, { userId: "fixture", timeZone: "UTC", initial: page, onCreateInChat: () => {} })
          : createComponent(CodeBlock, {
              timeZone: "UTC",
              chatOpen: false,
              disabled: false,
              onEdit: () => {},
              initial: { ref: { type: "example.box", id: "box_1" }, place: { name: "Logistik", canOwnCode: true }, page },
            });
      },
    }),
  );
test("the panel names a reviewed automation title, and without one when it runs, never the export name", () => {
  const titled = render("panel", "Lieferungen eintragen");
  expect(titled).toContain("Lieferungen eintragen");
  expect(titled).not.toContain("lieferungenEintragen");
  const untitled = render("panel");
  expect(untitled).toContain("Von Hand gestartet");
  expect(untitled).not.toContain("lieferungenEintragen");
});

test("an apps card shows the Code's name and when it runs, never the export name", () => {
  for (const title of ["Lieferungen eintragen", undefined]) {
    const html = render("apps", title);
    expect(html).toContain("Logistik");
    expect(html).toContain("Von Hand gestartet");
    expect(html).not.toContain("lieferungenEintragen");
  }
});

test("an apps card names a one-time instant in its declared zone in German and English", () => {
  for (const locale of ["de", "en"]) {
    const line = automationTiming({ kind: "schedule", cron: null, at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" }, locale);
    const expected = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(
      new Date("2026-12-01T09:15:30+01:00"),
    );
    expect(line).toContain(`${expected} (Europe/Berlin)`);
    expect(line).not.toMatch(/Handstart|Manual start/);
  }
});
