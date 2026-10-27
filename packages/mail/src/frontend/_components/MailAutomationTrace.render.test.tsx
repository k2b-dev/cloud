import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { logFixtureItems } from "./mail-automation-log-fixtures";
import type { AutomationLogItem } from "./mail-automation-log-model";

const root = mkdtempSync(join(tmpdir(), "mail-automation-trace-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailAutomationTrace } = await import("./MailAutomationTrace.tsx");

const render = (items: AutomationLogItem[], where: "top" | "bottom", canWrite = true) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(MailAutomationTrace, {
          items,
          where,
          canWrite,
          timeZone: "UTC",
          whyHref: (item) => `/app/mail/Box001/automations/log?entry=${item.id}`,
          orderHref: "/app/mail/Box001/automations",
          onUndo: () => undefined,
          onAssign: () => undefined,
          onAssignToMe: () => undefined,
        });
      },
    }),
  );
const byId = (id: string) => logFixtureItems.find((item) => item.id === id)!;

describe("MailAutomationTrace", () => {
  test("an AI rule's assignment leads with who got it, the ✦ kind, that names do not count, and Undo", () => {
    const html = render([byId("Log004")], "top");
    expect(html).toContain('data-mail-automation-note="assigned"');
    expect(html).toContain("„Mails nach Art verteilen“ hat Nora Albrecht zugewiesen.");
    expect(html).toContain("Art: Reklamation");
    expect(html).toContain("Namen in der Mail zählen nicht: Die KI wählt nur die Art, wer die Mail bekommt, steht fest in der Regel.");
    expect(html).toContain("Rückgängig");
    expect(html).toContain("Warum?");
    expect(html).not.toContain("--k2b-ai-surface");
  });

  test("an uncertain AI sits on the AI surface and offers to take the mail", () => {
    const html = render([byId("Log005")], "top");
    expect(html).toContain('data-mail-automation-note="uncertain"');
    expect(html).toContain("--k2b-ai-surface");
    expect(html).toContain("Die KI war unsicher. „Mails nach Art verteilen“ hat die Mail an „Eingang prüfen“ gegeben.");
    expect(html).toContain("Mir zuweisen");
    expect(html).toContain("Arten ansehen");
    expect(html).not.toContain(">Rückgängig<");
  });

  test("no note for a plain rule, an undone assignment, or a reader without write access to act", () => {
    expect(render([byId("Log007")], "top")).not.toContain("data-mail-automation-note");
    expect(render([{ ...byId("Log004"), undo: { state: "done", reason: null, by: null } }], "top")).not.toContain(
      "data-mail-automation-note",
    );
    expect(render([byId("Log004")], "top", false)).not.toContain("Rückgängig");
  });

  test("below the messages every effect stays as a quiet line, skipped ones point to the order", () => {
    const html = render([byId("Log002"), byId("Log003"), byId("Log008")], "bottom");
    expect(html).toContain("„Mails nach Art verteilen“ hat um 08:47 Team Angebote zugewiesen.");
    expect(html).toContain("„Großkunden an Can“ hat Zuweisen übersprungen:");
    expect(html).toContain("Reihenfolge ansehen");
    expect(html).toContain("Nora Albrecht hat um 06:40 Lisa Brandt zugewiesen.");
    expect(html).toContain("Die Regel bleibt, wie sie ist.");
  });
});
