import { describe, expect, setSystemTime, test } from "bun:test";
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
    locale: "en",
    sentence: {
      action: `Send “Offer ${id.slice(-1)}”`,
      running: "Sending",
      done: "Sent",
      confirm: `Send “Offer ${id.slice(-1)}”`,
      decline: "Don't run",
      rejected: `Rejected: Send “Offer ${id.slice(-1)}”`,
    },
    slots: {},
    ask: "app_asks",
    view: {
      version: 1,
      blocks: [
        {
          kind: "Detail",
          title: "Details",
          items: [
            { label: "To", value: "customer@example.com" },
            { label: "Body", value: "Hello,\nthe offer is attached." },
          ],
        },
      ],
    },
    links: [{ rel: "edit", href: "/app/mail/box/compose/draft" }],
  },
  requester: { kind: "chat", appId: "assistant", title: "Offer Q4", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: "2026-10-11T08:00:00.000Z",
  expiresAt: "2026-10-12T08:00:00.000Z",
  ...overrides,
});

const versionReview: PendingApproval["review"] = {
  locale: "en",
  sentence: {
    action: "Approve the reviewed version",
    running: "Recording approval",
    done: "Approval recorded",
    confirm: "Approve Report?",
    decline: "Don't run",
  },
  slots: {},
  ask: "changes_access",
  view: { version: 1, blocks: [{ kind: "Detail", title: "Version", items: [{ label: "Code", value: "Report" }] }] },
};

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

  const openDetails = async (host: ParentNode) => {
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      /^(See everything|Alles ansehen)$/.test(button.textContent?.trim() ?? ""),
    );
    expect(opener).toBeDefined();
    opener!.click();
    await waitFor(() => document.querySelector(".cloud-approval-details") !== null, "the complete proposal");
    return document.querySelector<HTMLElement>("dialog[open]")!;
  };
  const closeDetails = async () => {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await waitFor(() => document.querySelector(".cloud-approval-details") === null, "the closed proposal");
  };
  const mount = async (
    props: { initial?: ApprovalPage; link?: string; app?: string },
    answer: (url: string, init?: RequestInit) => Response | Promise<Response>,
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
    const { Approvals } = await import("@k2b/cloud/approvals/ui");
    delegateEvents(["click"]);
    const dispose = render(() => <Approvals app={props.app ?? "assistant"} initial={props.initial} link={props.link} />, dom.root);
    return {
      dom,
      requests,
      button: (label: string, within: ParentNode = dom.document) =>
        Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === label),
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("a rejection in flight says Cloud is saving the decision, never sending the message", async () => {
    setSystemTime(new Date("2026-10-12T07:51:00.000Z"));
    let finish: ((response: Response) => void) | undefined;
    const original = item("a1");
    const view = await mount({ initial: page([{ ...original, review: { ...original.review!, ask: "sends" } }]) }, (url) =>
      url.endsWith("/decision")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Response.json({ total: 0, apps: {} }),
    );
    try {
      await Bun.sleep(550);
      view.button("Don't run")!.click();
      await waitFor(() => Boolean(finish), "the pending rejection");
      const row = view.dom.root.querySelector<HTMLElement>("article.cloud-approval")!;
      expect(row.querySelector(".k2b-notice-card__title")?.textContent).toBe("Sending your answer …");
      expect(row.querySelector(".k2b-notice-card__detail-text")?.textContent).toBe("Cloud is saving your decision.");
      expect(row.textContent).not.toMatch(/Cloud is sending|message was sent/);
      finish!(Response.json({ status: "rejected" }));
      await waitFor(() => row.dataset.decided === "rejected", "the rejected receipt");
    } finally {
      finish?.(Response.json({ status: "rejected" }));
      view.cleanup();
      setSystemTime();
    }
  });

  test("each request is the chat's question card; an answer collapses it to its outcome line and keeps the others", async () => {
    const view = await mount({ initial: page([item("a1"), item("a2")]) }, () => Response.json({ status: "approved" }));
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      expect(rows()).toHaveLength(2);
      // The app supplies its sentence and view; the platform owns the question card.
      expect(rows()[0]?.querySelector(".k2b-notice-card__title")?.textContent).toBe("Send “Offer 1”?");
      expect(rows()[0]?.textContent).toContain("I'm asking because Mail always asks for this.");
      expect(rows()[0]?.textContent).not.toContain("customer@example.com");
      expect(rows()[0]?.textContent).not.toContain("Mail: Send");
      expect(rows()[0]?.querySelector("a")?.getAttribute("href")).toBe("/app/assistant?conversation=chat1");
      expect(rows()[0]?.textContent).not.toMatch(/Always approve|Immer freigeben/);
      expect(view.dom.root.textContent).toContain("2 open");
      // Answers arm after a short delay, so a click meant for the page cannot approve a row that just appeared.
      await Bun.sleep(550);
      view.button("Send “Offer 1”", rows()[0]!)!.click();
      await waitFor(() => rows()[0]?.dataset.decided === "approved", "the outcome");
      expect(view.requests.at(-1)).toEqual({ url: "/api/approvals/a1/decision", body: { approved: true } });
      expect(rows()).toHaveLength(2);
      expect(rows()[0]?.querySelector(".k2b-chat-decision__details")).toBeNull();
      expect(rows()[0]?.querySelector(".k2b-notice-card__content")?.textContent).toContain("Approved.");
      expect(rows()[0]?.querySelector(".cloud-approval-frame")?.getAttribute("data-outcome-tone")).toBe("done");
      expect(view.button("Send “Offer 2”", rows()[1]!)).toBeDefined();
      expect(view.dom.root.textContent).toContain("1 open");
    } finally {
      view.cleanup();
    }
  });

  test("one request shows no count beside it, and a request without details shows no details island", async () => {
    const bare = item("b1");
    if (!bare.review || !("sentence" in bare.review)) throw new Error("Expected a sentence review");
    const { view: _view, links: _links, ...withoutDetails } = bare.review;
    const view = await mount({ initial: page([{ ...bare, review: withoutDetails }]) }, () => Response.json({ status: "approved" }));
    try {
      expect(view.dom.root.querySelector(".cloud-approvals__toolbar")).toBeNull();
      expect(view.dom.root.textContent).not.toContain("1 open");
      expect(view.dom.root.querySelector("article.cloud-approval .k2b-notice-card__title")?.textContent).toBe("Send “Offer 1”?");
      expect(view.dom.root.querySelector("article.cloud-approval .k2b-chat-decision__details")).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("the author sees why another admin is required and can still reject", async () => {
    const request = item("code-author", {
      canApprove: false,
      requester: { kind: "code_version", appId: "demo", title: "Report", href: "/code/report/" },
    });
    const view = await mount({ initial: page([request]) }, () => Response.json({ status: "rejected" }));
    try {
      expect(view.dom.root.textContent).toContain("Another Cloud admin must approve your version.");
      await Bun.sleep(550);
      await openDetails(view.dom.root);
      const reject = view.button("Don't run");
      expect(reject?.disabled).toBe(false);
      reject!.click();
      await waitFor(() => view.requests.length > 0, "the rejection");
      expect(view.requests[0]?.body).toEqual({ approved: false });
    } finally {
      view.cleanup();
    }
  });

  test("a sole-admin review shows the notice, allows approval, and explains required reauthentication", async () => {
    const notice = "You are approving your own Code. There is no second Cloud admin to review it.";
    const request = item("sole-admin", {
      sentence: "Approve Report?",
      review: versionReview,
      canApprove: true,
      soleAdminNotice: notice,
      requester: { kind: "code_version", appId: "demo", title: "Report", href: "/code/report/" },
    });
    const view = await mount({ initial: page([request]) }, () => Response.json({ code: "REAUTHENTICATE" }, { status: 403 }));
    try {
      expect(view.dom.root.textContent).toContain(notice);
      expect(view.dom.root.textContent).not.toContain("Another Cloud admin must approve your version.");
      await Bun.sleep(550);
      view.button("Approve Report?")!.click();
      await waitFor(() => view.dom.root.textContent?.includes("Sign in to Cloud again") === true, "reauthentication recovery");
      expect(view.button("Answer again")).toBeDefined();
      expect(view.requests[0]?.body).toEqual({ approved: true });
    } finally {
      view.cleanup();
    }
  });

  test("a second admin appearing replaces the stale sole-admin choice with the required explanation", async () => {
    const request = item("second-admin", {
      sentence: "Approve Report?",
      review: versionReview,
      canApprove: true,
      soleAdminNotice: "You are approving your own Code. There is no second Cloud admin to review it.",
      requester: { kind: "code_version", appId: "demo", title: "Report", href: "/code/report/" },
    });
    const view = await mount({ initial: page([request]) }, () => Response.json({ code: "SELF_APPROVAL" }, { status: 403 }));
    try {
      await Bun.sleep(550);
      view.button("Approve Report?")!.click();
      await waitFor(
        () => view.dom.root.textContent?.includes("Another Cloud admin must approve your version.") === true,
        "updated eligibility",
      );
      expect(view.dom.root.textContent).not.toContain("There is no second Cloud admin");
      await openDetails(view.dom.root);
      expect(view.button("Don't run")?.disabled).toBe(false);
    } finally {
      view.cleanup();
    }
  });

  test("a Code-version request has its own source and receipt without a chat continuation", async () => {
    const request = item("code1", {
      sentence: "Approve Report?",
      review: versionReview,
      requester: { kind: "code_version", appId: "demo", title: "Report", href: "/code/report/" },
    });
    const view = await mount({ initial: page([request]) }, () => Response.json({ status: "approved" }));
    try {
      const row = view.dom.root.querySelector<HTMLElement>("article.cloud-approval")!;
      expect(row.querySelector("a")?.textContent).toBe("Code “Report”");
      expect(row.querySelector("a")?.getAttribute("href")).toBe("/code/report/");
      expect(row.textContent).not.toContain("from chat");
      await Bun.sleep(550);
      view.button("Approve Report?", row)!.click();
      await waitFor(() => row.dataset.decided === "approved", "version receipt");
      expect(row.textContent).toContain("Approval recorded for this version.");
      expect(row.textContent).not.toContain("The chat it came from");
    } finally {
      view.cleanup();
    }
  });

  for (const locale of ["de", "en"] as const)
    test(`${locale}: the approvals page preserves the chat's view`, async () => {
      const { actionFixtures, FIXTURE_AT } = await import("../ai/chat/action-question.fixtures");
      const block = actionFixtures(locale).sched!.block;
      const source = block.review;
      if (!source || !("sentence" in source)) throw new Error("Expected view review");
      const review = { ...source, draft: { editable: false, fields: [] } };
      const view = await mount({ initial: page([item("parity", { review, createdAt: FIXTURE_AT })]) }, () =>
        Response.json({ status: "rejected" }),
      );
      const { toolActionCard } = await import("../ai/chat/action-card");
      const { ApprovalCard } = await import("./ApprovalCard");
      const { legacyOutcomeWords } = await import("../ai/chat/tool-action-words");
      const chatRoot = document.createElement("section");
      view.dom.root.append(chatRoot);
      const card = toolActionCard({ ...block, review }, { locale, timeZone: "UTC", outcome: legacyOutcomeWords(block, locale, "UTC") });
      const disposeChat = render(
        () => (
          <ApprovalCard
            card={card}
            state="open"
            timeZone="UTC"
            onConfirm={() => {}}
            onDecline={() => {}}
            outcome={{ lines: {}, current: "" }}
          />
        ),
        chatRoot,
      );
      try {
        const approval = view.dom.root.querySelector("article.cloud-approval")!;
        const shown: string[] = [];
        for (const host of [approval, chatRoot]) {
          const dialog = await openDetails(host);
          const details = dialog.querySelector(".cloud-action-details")!;
          shown.push(details.textContent ?? "");
          for (const value of ["Lea Berg", "Mira Hoffmann", "Tom Weber", "Wartungsplan-KW43.pdf"])
            expect(details.textContent).toContain(value);
          expect(dialog.querySelector<HTMLInputElement>("input")?.readOnly).toBe(true);
          expect(dialog.querySelector('a[href="/app/mail/drafts/dr-42?revision=7"]')).not.toBeNull();
          await closeDetails();
        }
        expect(shown[0]).toBe(shown[1]);
        expect(view.requests.filter((request) => request.url.endsWith("/decision"))).toEqual([]);
      } finally {
        disposeChat();
        view.cleanup();
      }
    });

  test("a review in another language keeps that language in its outcome line too", async () => {
    const { actionFixtures } = await import("../ai/chat/action-question.fixtures");
    const source = actionFixtures("de").mail!.block.review!;
    const review = { ...source, draft: { editable: false, fields: [] } };
    if (!("sentence" in review)) throw new Error("Expected a new review");
    const view = await mount({ initial: page([item("a1", { review })]) }, () => Response.json({ status: "rejected" }));
    try {
      const row = () => view.dom.root.querySelector<HTMLElement>("article.cloud-approval")!;
      await Bun.sleep(550);
      const dialog = await openDetails(row());
      view.button(review.sentence.decline!, dialog)!.click();
      await waitFor(() => row().dataset.decided === "rejected", "the outcome");
      const line = row().querySelector(".k2b-notice-card__content")?.textContent ?? "";
      expect(line).toContain("Du hast abgelehnt.");
      expect(line).not.toContain("You declined.");
    } finally {
      view.cleanup();
    }
  });

  test("a request decided elsewhere or gone says so; another failure offers to answer again", async () => {
    const statuses = new Map([
      ["/api/approvals/a1/decision", 409],
      ["/api/approvals/a2/decision", 404],
      ["/api/approvals/a3/decision", 500],
      ["/api/approvals/a4/decision", 200],
    ]);
    const view = await mount({ initial: page([item("a1"), item("a2"), item("a3"), item("a4")]) }, (url) =>
      Response.json(statuses.get(url) === 200 ? { status: "rejected" } : { message: "no" }, { status: statuses.get(url) ?? 500 }),
    );
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      const sentence = (row: HTMLElement | undefined) => row?.querySelector(".k2b-notice-card__title")?.textContent?.trim() ?? "";
      const line = (row: HTMLElement | undefined) =>
        [sentence(row), row?.querySelector(".k2b-notice-card__detail-text")?.textContent?.trim()].filter(Boolean).join(" ");
      const tone = (row: HTMLElement | undefined) => row?.querySelector(".cloud-approval-frame")?.getAttribute("data-outcome-tone");
      await Bun.sleep(550);
      for (const row of rows()) {
        const dialog = await openDetails(row);
        view.button("Don't run", dialog)!.click();
        await closeDetails();
      }
      await waitFor(() => line(rows()[2]).includes("Your decision was not applied."), "the failure");
      await waitFor(() => rows()[3]?.dataset.decided === "rejected", "the rejection");
      // A 409 or 404 changed nothing: the line says so in a neutral tone, never the success check.
      expect(rows()[0]?.dataset.decided).toBe("elsewhere");
      expect(sentence(rows()[0])).toBe("Already decided elsewhere");
      expect(line(rows()[0])).toContain("The request is no longer open");
      expect(line(rows()[0])).not.toContain("Nothing was run");
      expect(tone(rows()[0])).toBe("off");
      expect(rows()[1]?.dataset.decided).toBe("gone");
      expect(sentence(rows()[1])).toBe("Expired or withdrawn");
      expect(rows()[2]?.dataset.decided).toBeUndefined();
      expect(tone(rows()[2])).toBe("warning");
      expect(line(rows()[3])).toContain("Rejected: Send “Offer 4”");
      expect(line(rows()[3])).toContain("You declined.");
      // Answering again brings back the question, armed, in the same place.
      view.button("Answer again", rows()[2]!)!.click();
      await waitFor(() => rows()[2]?.querySelector('.cloud-approval-frame[data-state="open"]') !== null, "the question again");
      expect(view.button("Send “Offer 3”", rows()[2]!)).toBeDefined();
    } finally {
      view.cleanup();
    }
  });

  test("a failed next page keeps the rows and offers a retry next to the button", async () => {
    let failNext = true;
    let finishRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    const view = await mount({ initial: page([item("a1")], { nextCursor: "next", count: 2 }) }, (url) => {
      if (!url.startsWith("/api/approvals?")) return Response.json({ message: "no" }, { status: 500 });
      if (failNext) return Response.json({ message: "unavailable" }, { status: 503 });
      // The browser parses fetched pages strictly, so this row needs a real request id.
      return pendingRetry;
    });
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      view.button("Show more")!.click();
      await waitFor(() => view.dom.root.querySelector('.cloud-approvals__more [role="alert"]') !== null, "the inline error");
      expect(view.dom.root.querySelector(".cloud-approvals__more")?.textContent).toContain("More approvals could not be loaded.");
      expect(rows()).toHaveLength(1);
      expect(view.button("Show more")).toBeUndefined();
      failNext = false;
      const retry = view.button("Try again")!;
      const alert = view.dom.root.querySelector('.cloud-approvals__more [role="alert"]');
      retry.click();
      expect(retry.disabled).toBe(true);
      expect(retry.textContent?.trim()).toBe("Try again");
      expect(view.dom.root.querySelector('.cloud-approvals__more [role="alert"]')).toBe(alert);
      finishRetry(Response.json(page([item("00000000-0000-4000-8000-0000000000a2")], { count: 2 })));
      await waitFor(() => rows().length === 2, "the next page");
      expect(view.requests.filter((request) => request.url.startsWith("/api/approvals?"))).toHaveLength(2);
      expect(view.dom.root.querySelector('.cloud-approvals__more [role="alert"]')).toBeNull();
      expect(view.dom.root.querySelector(".cloud-approvals__more")).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("a proposal without detail blocks still shows the pure reason and expiry exactly once in its dialog", async () => {
    setSystemTime(new Date("2026-10-12T07:51:00.000Z"));
    const request = item("a1");
    if (!request.review || !("sentence" in request.review)) throw new Error("Fixture must use a sentence review");
    const view = await mount(
      { initial: page([{ ...request, review: { ...request.review, view: { version: 1, blocks: [] }, links: [] } }]) },
      () => Response.json({ status: "approved" }),
    );
    try {
      const dialog = await openDetails(view.dom.root);
      const paragraphs = [...dialog.querySelectorAll(".cloud-approval-details > p")].map((p) => p.textContent);
      expect(paragraphs[0]).toBe("I'm asking because Mail always asks for this.");
      expect(paragraphs.filter((p) => p?.includes("Expires"))).toEqual(["Expires in 9 min."]);
      expect(dialog.querySelector(".cloud-action-details")).toBeNull();
      expect(view.requests).toEqual([]);
    } finally {
      view.cleanup();
      setSystemTime();
    }
  });

  test("offers to remember for the chat only where the request offers it, and never Always", async () => {
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
      expect(rows[1]?.querySelector(".k2b-notice-card__description")?.textContent).not.toContain("Asks every time");
      expect(view.dom.root.querySelector("input[type=checkbox]")).toBeNull();
      await Bun.sleep(550);
      const dialog = await openDetails(rows[0]!);
      const checkbox = dialog.querySelector<HTMLInputElement>("input[type=checkbox]")!;
      expect(checkbox).not.toBeNull();
      expect(dialog.textContent).toContain("Don't ask again in this chat");
      expect(dialog.textContent).not.toMatch(/Always approve|Immer freigeben/);
      checkbox.click();
      view.button("Send “Offer 1”", dialog)!.click();
      await waitFor(() => view.requests.length > 0, "the decision");
      expect(view.requests.at(-1)).toEqual({ url: "/api/approvals/a1/decision", body: { approved: true, remember: "chat" } });
    } finally {
      view.cleanup();
    }
  });

  test("shows the empty state, and loads without a server page", async () => {
    const view = await mount({}, () => Response.json(page([], { elsewhere: 2 })));
    try {
      await waitFor(() => view.dom.root.textContent?.includes("You're all set.") === true, "the empty state");
      expect(view.requests[0]?.url).toBe("/api/approvals?app=assistant");
      expect(view.dom.root.textContent).toContain("More approvals in other apps (2)");
      expect(view.dom.root.querySelector('a[href="/me/approvals"]')).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("a list beside one resource shows nothing when nothing waits, and Cloud's one approval card when one does", async () => {
    const empty = await mount({ initial: page([]), link: "/mail/drafts/d1", app: "mail" }, () => Response.json({}));
    try {
      expect(empty.dom.root.innerHTML).toBe("");
    } finally {
      empty.cleanup();
    }
    const scoped = await mount({ initial: page([item("a1")]), link: "/mail/drafts/d1", app: "mail" }, () =>
      Response.json({ status: "rejected" }),
    );
    try {
      const row = scoped.dom.root.querySelector<HTMLElement>("article.cloud-approval")!;
      // The same card as everywhere: no count or bulk action beside one resource.
      expect(row.querySelector(".cloud-approval-frame")?.getAttribute("data-k2b-primary")).toBe("ai");
      expect(scoped.dom.root.querySelector(".cloud-approvals__toolbar")).toBeNull();
      expect(row.querySelector(".k2b-notice-card__description")?.textContent).toContain("I'm asking because Mail always asks for this.");
    } finally {
      scoped.cleanup();
    }
  });
});
