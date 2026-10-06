import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ScheduledSend } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "mail-scheduled-view-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MailScheduledView }, { LocaleProvider }] = await Promise.all([import("./MailScheduledView.tsx"), import("@k2b/ui")]);

const item: ScheduledSend = {
  id: "Deliv1",
  commandId: "00000000-0000-4000-8000-000000000002",
  draftId: "Draft1",
  conversationId: null,
  intent: "new",
  to: [{ name: null, address: "recipient@example.com" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  bodyPreview: "Preview",
  scheduledAt: "2026-07-18T09:00:00.000Z",
  nextAttemptAt: null,
  state: "scheduled",
  attempt: 0,
  lastErrorCode: "MAILBOX_AUTH_REQUIRED",
  lastError: "The mailbox needs a new login; the message goes out once it is signed in again",
  scheduledBy: { kind: "user", displayName: "Ada" },
  createdAt: "2026-07-17T09:00:00.000Z",
};

const render = (items: ScheduledSend[], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailScheduledView, {
          mailboxId: "Mail01",
          page: { items, nextCursor: null, total: items.length },
          error: null,
          dateConfig: { locale, timeZone: "Europe/Berlin" },
          canWrite: true,
          loading: false,
          onNavigate: () => undefined,
          onRefresh: async () => undefined,
        });
      },
    }),
  );

describe("Mail scheduled view", () => {
  test("shows a send that waits for its mailbox's sign-in as waiting, not as a failed retry", () => {
    const html = render([item]);
    expect(html).toContain("Waiting for sign-in");
    expect(html).toContain("ti-lock");
    expect(html).toContain("The mailbox needs to be signed in again.");
    expect(html).not.toContain("Delivery retry pending");
    expect(html).not.toContain(item.lastError!);

    const german = render([item], "de");
    expect(german).toContain("Wartet auf Anmeldung");
    expect(german).not.toContain("Erneute Zustellung ausstehend");
  });

  test("keeps the retry label for a send that failed otherwise", () => {
    const html = render([{ ...item, lastErrorCode: "OUTBOX_PREDISPATCH_RETRY", lastError: "Connection failed" }]);
    expect(html).toContain("Delivery retry pending");
    expect(html).not.toContain("Waiting for sign-in");
  });
});
