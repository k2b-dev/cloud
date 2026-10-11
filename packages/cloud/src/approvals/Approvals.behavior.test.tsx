import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { ApprovalPage, PendingApproval } from "../contracts/approvals";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const item = (id: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  id,
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm",
  sentence: `Mail: Send “Offer ${id.slice(-1)}”`,
  review: {
    message: "Sends the draft after the undo window.",
    details: [
      { label: "To", value: "customer@example.com" },
      { label: "Body", value: "Hello,\nthe offer is attached.", display: "block" },
    ],
    links: [{ rel: "edit", href: "/app/mail/box/compose/draft" }],
  },
  requester: { kind: "chat", appId: "assistant", title: "Offer Q4", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
  ...overrides,
});

const page = (items: PendingApproval[], overrides: Partial<ApprovalPage> = {}): ApprovalPage => ({
  items,
  nextCursor: null,
  count: items.length,
  elsewhere: 0,
  ...overrides,
});

describe("Approvals", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (
    props: { initial?: ApprovalPage; layout?: "list" | "band"; app?: string },
    answer: (url: string, init?: RequestInit) => Response,
  ) => {
    const dom = createDomTestHarness();
    const requests: { url: string; body: unknown }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return answer(url, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: Approvals } = await import("./Approvals");
    delegateEvents(["click"]);
    const dispose = render(() => <Approvals app={props.app ?? "assistant"} initial={props.initial} layout={props.layout} />, dom.root);
    return {
      dom,
      requests,
      button: (label: string, within: ParentNode = dom.root) =>
        Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === label),
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("a decision turns its row into a receipt in place and keeps the others", async () => {
    const view = await mount({ initial: page([item("a1"), item("a2")]) }, () => Response.json({ status: "approved" }));
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      expect(rows()).toHaveLength(2);
      expect(rows()[0]?.textContent).toContain("Send “Offer 1”");
      expect(rows()[0]?.textContent).not.toContain("Mail: Send");
      expect(rows()[0]?.textContent).toContain("Asks every time");
      expect(rows()[0]?.querySelector("a")?.getAttribute("href")).toBe("/app/assistant?conversation=chat1");
      expect(view.dom.root.textContent).toContain("2 open");
      // Decision buttons arm after a short delay, so a click meant for the page cannot approve a row that just appeared.
      await Bun.sleep(550);
      view.button("Approve", rows()[0]!)!.click();
      await waitFor(() => rows()[0]?.dataset.decided === "true", "the receipt");
      expect(view.requests.at(-1)).toEqual({ url: "/api/approvals/a1/decision", body: { approved: true } });
      expect(rows()).toHaveLength(2);
      expect(rows()[0]?.textContent).toContain("Approved");
      expect(view.button("Approve", rows()[0]!)).toBeUndefined();
      expect(view.button("Approve", rows()[1]!)).toBeDefined();
      expect(view.dom.root.textContent).toContain("1 open");
    } finally {
      view.cleanup();
    }
  });

  test("a request decided elsewhere or gone becomes a receipt; other failures keep the buttons", async () => {
    const statuses = new Map([
      ["/api/approvals/a1/decision", 409],
      ["/api/approvals/a2/decision", 404],
      ["/api/approvals/a3/decision", 500],
    ]);
    const view = await mount({ initial: page([item("a1"), item("a2"), item("a3")]) }, (url) =>
      Response.json({ message: "no" }, { status: statuses.get(url) ?? 500 }),
    );
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      await Bun.sleep(550);
      for (const row of rows()) view.button("Reject", row)!.click();
      await waitFor(() => rows()[2]?.textContent?.includes("The decision was not saved") === true, "the failure");
      expect(rows()[0]?.textContent).toContain("Already decided elsewhere");
      expect(rows()[1]?.textContent).toContain("Expired or withdrawn");
      expect(rows()[2]?.dataset.decided).toBeUndefined();
      expect(view.button("Reject", rows()[2]!)).toBeDefined();
    } finally {
      view.cleanup();
    }
  });

  test("offers remember options only where the request does", async () => {
    const view = await mount(
      {
        initial: page([
          item("a1", { assurance: "standard", remember: { chat: true, always: true, website: false } }),
          item("a2", { remember: { chat: true, always: true, website: false } }),
        ]),
      },
      () => Response.json({ status: "approved" }),
    );
    try {
      const rows = Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      expect(rows[0]?.querySelector(".k2b-split-button")).not.toBeNull();
      // `confirm` asks every time, whatever the stored options say.
      expect(rows[1]?.querySelector(".k2b-split-button")).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("shows the empty state, and loads without a server page", async () => {
    const view = await mount({}, () => Response.json(page([], { elsewhere: 2 })));
    try {
      await waitFor(() => view.dom.root.textContent?.includes("Nothing is waiting for you.") === true, "the empty state");
      expect(view.requests[0]?.url).toBe("/api/approvals?app=assistant");
      expect(view.dom.root.textContent).toContain("More approvals in other apps (2)");
      expect(view.dom.root.querySelector('a[href="/me/approvals"]')).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("a band shows nothing when nothing waits, and the request when one does", async () => {
    const empty = await mount({ initial: page([]), layout: "band", app: "mail" }, () => Response.json({}));
    try {
      expect(empty.dom.root.innerHTML).toBe("");
    } finally {
      empty.cleanup();
    }
    const band = await mount({ initial: page([item("a1")]), layout: "band", app: "mail" }, () => Response.json({ status: "rejected" }));
    try {
      const row = band.dom.root.querySelector<HTMLElement>("article.cloud-approval-band")!;
      expect(row.textContent).toContain("Send “Offer 1”");
      await Bun.sleep(550);
      band.button("Reject", row)!.click();
      await waitFor(() => row.dataset.decided === "true", "the band receipt");
      expect(row.textContent).toContain("Rejected");
    } finally {
      band.cleanup();
    }
  });
});
