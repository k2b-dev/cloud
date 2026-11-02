import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CodeAutomation, CodeSummary } from "../code-summary";

const root = mkdtempSync(join(tmpdir(), "assistant-code-titles-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
beforeAll(() => setSystemTime(new Date("2026-11-01T12:00:00.000Z")));
afterAll(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
});
const [{ default: CodeView }, { default: CodeBlock }, { LocaleProvider }] = await Promise.all([
  import("./AssistantCodeView"),
  import("./AssistantCodeBlock"),
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
          ? createComponent(CodeView, { userId: "fixture", timeZone: "UTC", initial: page, initialToday: null, onCreateInChat: () => {} })
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
for (const surface of ["apps", "panel"] as const)
  test(`${surface} renders reviewed automation titles with identifier fallback`, () => {
    const titled = render(surface, "Lieferungen eintragen");
    expect(titled).toContain("Lieferungen eintragen");
    expect(titled).not.toContain(">lieferungenEintragen<");
    expect(render(surface)).toContain("lieferungenEintragen");
  });
