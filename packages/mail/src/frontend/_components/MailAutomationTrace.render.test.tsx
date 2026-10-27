import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { automationLogDetailSchema, automationLogItemSchema } from "../../contracts";
import { logFixtureDetail, logFixtureItems } from "./mail-automation-log-fixtures";
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
const byId = (n: number) => logFixtureItems[n - 1]!;

describe("MailAutomationTrace", () => {
  test("an AI rule's assignment leads with who got it, the ✦ kind, that names do not count, and Undo", () => {
    const html = render([byId(4)], "top");
    expect(html).toContain('data-mail-automation-note="assigned"');
    expect(html).toContain("„Mails nach Art verteilen“ hat Nora Albrecht zugewiesen.");
    expect(html).toContain("Art: Reklamation");
    expect(html).toContain("Namen in der Mail zählen nicht: Die KI wählt nur die Art, wer die Mail bekommt, steht fest in der Regel.");
    expect(html).toContain("Rückgängig");
    expect(html).toContain("Warum?");
    expect(html).not.toContain("--k2b-ai-surface");
  });

  test("an uncertain AI sits on the AI surface and offers to take the mail", () => {
    const html = render([byId(5)], "top");
    expect(html).toContain('data-mail-automation-note="uncertain"');
    expect(html).toContain("--k2b-ai-surface");
    expect(html).toContain("Die KI war unsicher. „Mails nach Art verteilen“ hat die Mail an „Eingang prüfen“ gegeben.");
    expect(html).toContain("Mir zuweisen");
    expect(html).toContain("Arten ansehen");
    expect(html).not.toContain(">Rückgängig<");
  });

  test("no note for a plain rule, an undone assignment, or a reader without write access to act", () => {
    expect(render([byId(7)], "top")).not.toContain("data-mail-automation-note");
    expect(render([{ ...byId(4), undo: { state: "done", reason: null, by: null, at: null } }], "top")).not.toContain(
      "data-mail-automation-note",
    );
    expect(render([byId(4)], "top", false)).not.toContain("Rückgängig");
  });

  test("below the messages every effect stays as a quiet line, skipped ones point to the order", () => {
    const html = render([byId(2), byId(3), byId(8)], "bottom");
    expect(html).toContain("„Mails nach Art verteilen“ hat um 08:47 Team Angebote zugewiesen.");
    expect(html).toContain("„Großkunden an Can“ hat Zuweisen übersprungen:");
    expect(html).toContain("Reihenfolge ansehen");
    expect(html).toContain("Nora Albrecht hat um 06:40 Lisa Brandt zugewiesen.");
    expect(html).toContain("Die Regel bleibt, wie sie ist.");
  });

  test("a later skipped rule keeps the current assignment as the note; a manual change ends it", () => {
    expect(render([byId(3), byId(2)], "top")).toContain("„Mails nach Art verteilen“ hat Team Angebote zugewiesen.");
    expect(render([byId(8), byId(4)], "top")).not.toContain("data-mail-automation-note");
  });

  test("undone and failed effects say so below the messages", () => {
    const undone = render([{ ...byId(2), undo: { state: "done", reason: null, by: null, at: "2026-10-26T09:15:00.000Z" } }], "bottom");
    expect(undone).toContain("Rückgängig gemacht · 09:15");
    expect(undone).toContain("line-through");
    const failed = render([{ ...byId(7), outcome: "failed", effects: [], reasons: [] }], "bottom");
    expect(failed).toContain("„Rechnungen ablegen“ ist um 07:05 fehlgeschlagen.");
    expect(failed).toContain("Die Mail ist unverändert.");
  });

  test("the fixtures are what the API returns", () => {
    for (const item of logFixtureItems) expect(automationLogItemSchema.safeParse(item).success).toBe(true);
    expect(automationLogDetailSchema.safeParse(logFixtureDetail()).success).toBe(true);
  });
});
