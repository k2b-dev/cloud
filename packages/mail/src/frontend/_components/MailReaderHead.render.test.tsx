import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MailLinkedItem } from "./mail-conversation-links";

const root = mkdtempSync(join(tmpdir(), "mail-reader-head-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailReaderHead, fittingChipCount } = await import("./MailReaderHead.tsx");

type LinkedState = "loading" | "error" | "ready";

const renderHead = (state: LinkedState, items: MailLinkedItem[] = []) =>
  renderToString(() =>
    createComponent(MailReaderHead, {
      subject: "Quarterly review",
      noSubject: "(no subject)",
      flagged: false,
      flaggedLabel: "Flagged",
      closeHref: "/app/mail/mb",
      onClose: () => {},
      canWrite: true,
      dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      workStatus: "needs_action",
      completionPending: false,
      onToggleCompletion: () => {},
      actionPending: false,
      deleteBlocked: null,
      onArchive: () => {},
      onDelete: () => {},
      snoozedUntil: null,
      reminderDueAt: null,
      assignees: null,
      onAssign: () => {},
      keep: null,
      keptTitle: null,
      onStopKeeping: null,
      tags: [],
      onManageTags: null,
      linked: {
        items,
        state,
        retry: () => {},
        enabled: true,
      },
      senderLabel: "Ada Lovelace",
      messageCount: 2,
      presence: [],
      laterItems: () => [],
      menuItems: () => [],
      menuLabel: "More conversation actions",
      hint: null,
      onHintSeen: () => {},
    }),
  );

describe("Mail reader head links chip", () => {
  test("links that could not load show no chip, so the head has no permanent noise", () => {
    const html = renderHead("error");
    expect(html).not.toContain("ti-link-off");
    expect(html).not.toContain("Links unavailable");
    expect(html).not.toContain("linked");
  });

  test("links show one chip with their count once they loaded", () => {
    expect(renderHead("ready", [{ id: "T1", title: "Order planks", icon: "ti ti-checkbox", href: "/app/items/T1" }])).toContain("1 linked");
    expect(renderHead("loading")).not.toContain("linked");
  });
});

describe("Mail reader head chip fit", () => {
  test("a single chip that fills a list as wide as its content stays visible", () => {
    expect(fittingChipCount({ widths: [72.4], available: 72.4, gap: 6 })).toBe(1);
  });

  test("chips that fill their content-sized list all stay visible; the gap counts only between chips", () => {
    expect(fittingChipCount({ widths: [72, 90, 40], available: 72 + 6 + 90 + 6 + 40, gap: 6 })).toBe(3);
  });

  test("when the row is too narrow, chips after the first that does not fit wait behind +n, leaving its room", () => {
    expect(fittingChipCount({ widths: [72, 90, 40], available: 150, gap: 6 })).toBe(1);
    expect(fittingChipCount({ widths: [200], available: 150, gap: 6 })).toBe(0);
  });
});
