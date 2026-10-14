import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { IncomingAutomationBackfill } from "../../contracts";
import type { IncomingAutomation } from "../../service/incoming-automations";

const now = "2026-10-11T09:00:00.000Z";
const operationId = "00000000-0000-4000-8000-000000000010";

const automation: IncomingAutomation = {
  id: "Auto01",
  mailboxId: "Box001",
  workflowId: "00000000-0000-4000-8000-000000000001",
  workflowVersionId: "00000000-0000-4000-8000-000000000002",
  name: "File receipts",
  enabled: true,
  scope: { mode: "all" },
  steps: [{ id: "00000000-0000-4000-8000-000000000003", kind: "mail_action", action: { kind: "mark_read" } }],
  latestBackfillOperationId: operationId,
  workflowSource: "steps: []",
  revision: 4,
  createdAt: now,
  updatedAt: now,
};

const retryBackfill = (overrides: Partial<IncomingAutomationBackfill>): IncomingAutomationBackfill => ({
  operationId,
  automationId: automation.id,
  workflowVersionId: automation.workflowVersionId,
  retryFailed: true,
  state: "limited",
  candidateCount: 250,
  alreadyAcceptedCount: 0,
  newlyAcceptedCount: 100,
  remainingCount: 150,
  failureCount: 0,
  lastError: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

// Load once outside the test, so the cold Solid transform of the settings graph does not count against its timeout.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: Settings }, { LocaleProvider, prompts }] = await Promise.all([
      import("./MailIncomingAutomationSettings"),
      import("@k2b/ui"),
    ]);
    return { Settings, LocaleProvider, prompts };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

test.skipIf(isServer)("continues a limited retry backfill with another retry instead of a normal backfill", async () => {
  const { Settings, LocaleProvider, prompts } = modules!;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let started: IncomingAutomationBackfill | null = null;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
      const text = input instanceof Request ? await input.text() : typeof init?.body === "string" ? init.body : "";
      requests.push({ method, path: url.pathname, body: text ? JSON.parse(text) : null });
      if (method === "POST" && url.pathname.endsWith("/backfills")) {
        const body = JSON.parse(text) as { operationId: string };
        started = retryBackfill({ operationId: body.operationId, state: "queued", newlyAcceptedCount: 0 });
        return Response.json(started);
      }
      return Response.json(started && url.pathname.endsWith(started.operationId) ? started : retryBackfill({}));
    },
    { preconnect: originalFetch.preconnect },
  );
  const confirmation = spyOn(prompts, "confirm").mockResolvedValue(true);
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <Settings mailboxId="Box001" catalog={{ folders: [], assignableUsers: [] }} initialAutomations={[automation]} />
      </LocaleProvider>
    ),
    dom.root,
  );
  const text = () => dom.root.textContent ?? "";
  try {
    for (let i = 0; i < 100 && !text().includes("Limit reached · 100 retried, 150 left"); i++) await Bun.sleep(10);
    expect(text()).toContain("Limit reached · 100 retried, 150 left");

    dom.document.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${automation.name}"]`)?.click();
    const items = Array.from(dom.document.querySelectorAll<HTMLElement>("[role='menuitem']"));
    const labels = items.map((item) => item.textContent?.trim());
    expect(labels).toContain("Retry failed messages");
    expect(labels).not.toContain("Run backfill again");
    items.find((item) => item.textContent?.trim() === "Retry failed messages")!.click();

    for (let i = 0; i < 100 && !requests.some((request) => request.method === "POST"); i++) await Bun.sleep(10);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmation.mock.calls[0]?.[1]).toMatchObject({ title: "Retry failed messages?", confirmText: "Start retry" });
    // A retry does not preview the scope: the scope count is not the number of messages it runs again.
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/api/mail/mailboxes/Box001/incoming-automations/${automation.id}/backfills`,
        body: { operationId: expect.any(String), expectedRevision: 4, retryFailed: true },
      },
    ]);
    for (let i = 0; i < 100 && !text().includes("Retry · 0/250"); i++) await Bun.sleep(10);
    expect(text()).toContain("Retry · 0/250");
  } finally {
    dispose();
    confirmation.mockRestore();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
