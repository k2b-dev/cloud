import { afterEach, beforeEach, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await Promise.all([import("./MailCodeTools"), import("./MailCodeTools.fixture"), import("@k2b/ui")]);
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const time = "2026-11-01T12:00:00.000Z";
const VERSION_4 = "00000000-0000-4000-8000-000000000004";
const event = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time,
  subject: { type: "mail.message", id: "Msg123" },
  place: { type: "mail.mailbox", id: "Mb4kd2" },
  data: { receiptId: "00000000-0000-4000-8000-000000000002" },
};
const status = (operationId: string, overrides: Record<string, unknown> = {}) => ({
  operationId,
  versionId: VERSION_4,
  status: "running",
  total: 1,
  dispatched: 0,
  failureCount: 0,
  lastError: null,
  createdAt: time,
  updatedAt: time,
  ...overrides,
});
const waits = new Set<MutationObserver>();
// Bound by the test timeout; resolve from the actual DOM transition, without a polling budget.
const waitFor = (condition: () => boolean) =>
  new Promise<void>((resolve) => {
    if (condition()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!condition()) return;
      observer.disconnect();
      waits.delete(observer);
      resolve();
    });
    waits.add(observer);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  });

if (isServer) test.skip("Mail Code catch-up runs in the browser-conditions process", () => {});
else {
  const [{ default: MailCodeCatchUp }, { mailCodeCatchUpFixture }, { LocaleProvider }] = modules!;
  type Fixture = Parameters<typeof mailCodeCatchUpFixture>[0];
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let requests: { path: string; input: Record<string, unknown> }[];
  /** How Core answers the next writing request: accepted, refused with a status, or lost on the way back. */
  let startAnswer: "ok" | "lost" | 403 | 409 = "ok";
  let activeVersion = VERSION_4;
  const mount = (state: Fixture) => {
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailCodeCatchUp data={mailCodeCatchUpFixture(state, "en")} />
        </LocaleProvider>
      ),
      dom.root,
    );
  };
  beforeEach(() => {
    dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", "/app/mail/Mb4kd2/code/catch-up");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    delegateEvents(["click"]);
    requests = [];
    startAnswer = "ok";
    activeVersion = VERSION_4;
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(url), "http://localhost").pathname;
        const body = JSON.parse(String(init?.body));
        requests.push({ path, input: body.input ?? body });
        const reply = (data: object) => Response.json({ data });
        if (path.endsWith("/queries/mail/message.catchup"))
          return reply({ cutoffAt: time, items: [{ title: "Delivery notice", event }], nextCursor: null });
        if (path.endsWith("/queries/core/code.read")) return reply({ code: { state: "active", activeVersionId: activeVersion } });
        if (path.endsWith("/queries/core/code.event.catchup.read")) return reply(status(body.input.operationId));
        if (path.endsWith("/actions/core/code.event.catchup") || path.endsWith("/actions/core/code.event.catchup.resume")) {
          const answer = startAnswer;
          startAnswer = "ok";
          if (answer === "lost") throw new Error("response lost");
          if (answer !== "ok") return Response.json({ code: "REFUSED", message: "Refused" }, { status: answer });
          return reply(status(body.input.newOperationId ?? body.input.operationId));
        }
        if (path.endsWith("/actions/core/code.event.catchup.cancel"))
          return reply(status(body.input.operationId, { status: "canceled", total: 12, dispatched: 7 }));
        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    for (const observer of waits) observer.disconnect();
    waits.clear();
    dispose();
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    dom.cleanup();
  });
  const text = () => dom.root.textContent ?? "";
  const find = (label: string) =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label);
  /** Clicks once the button is there and enabled: the previous action has finished. */
  const click = async (label: string) => {
    await waitFor(() => find(label)?.disabled === false);
    find(label)?.click();
  };
  const starts = () => requests.filter((request) => request.path.endsWith("/actions/core/code.event.catchup"));
  const preview = async () => {
    await click("Load preview");
    await waitFor(() => find("Apply to 1 message")?.disabled === false);
  };

  test("the preview reads the selection with an inclusive end and keeps it in the address", async () => {
    mount("auswahl");
    await preview();
    expect(requests[0]).toEqual({
      path: "/api/capabilities/v1/queries/mail/message.catchup",
      input: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-14T00:00:00.000Z" },
    });
    expect(text()).toContain("1 message from Nov 1 to Nov 13 in all incoming folders");
    expect(location.search).toContain(`preview=${VERSION_4}`);
    // Nothing is sent to the automation before "Apply".
    expect(starts()).toHaveLength(0);
    await click("Other selection");
    await waitFor(() => !text().includes("Apply to 1 message"));
    expect(location.search).not.toContain("preview=");
  });

  test("applying pins the switched-on version and shows progress at the operation's own address", async () => {
    mount("auswahl");
    await preview();
    await click("Apply to 1 message");
    await waitFor(() => text().includes("0 of 1 messages handed over"));
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.input).toMatchObject({ versionId: VERSION_4, events: [event] });
    expect(text()).toContain("Running");
    expect(location.search).toContain(`operation=${starts()[0]!.input.operationId}`);
  });

  test("a lost answer is unclear and “Check status” resends the exact snapshot, never a new one", async () => {
    mount("auswahl");
    await preview();
    startAnswer = "lost";
    await click("Apply to 1 message");
    await waitFor(() => text().includes("Outcome unclear"));
    expect(text()).not.toContain("Try again");
    await click("Check status");
    await waitFor(() => text().includes("0 of 1 messages handed over"));
    expect(starts()).toHaveLength(2);
    expect(starts()[0]!.input).toEqual(starts()[1]!.input);
  });

  test("a refusal says nothing changed and keeps the preview for another try", async () => {
    mount("auswahl");
    await preview();
    startAnswer = 403;
    await click("Apply to 1 message");
    await waitFor(() => text().includes("Cloud did not start processing."));
    expect(text()).toContain("You lack the right to do this right now. Nothing changes on the mail or the automation.");
    await click("Apply to 1 message");
    await waitFor(() => text().includes("0 of 1 messages handed over"));
    expect(starts()[0]!.input.operationId).not.toBe(starts()[1]!.input.operationId);
  });

  test("a conflict without a new version keeps the receipt and asks to check the status", async () => {
    mount("auswahl");
    await preview();
    startAnswer = 409;
    await click("Apply to 1 message");
    await waitFor(() => text().includes("Processing is already starting."));
    expect(requests.some((request) => request.path.endsWith("/queries/core/code.read"))).toBe(true);
    await click("Check status");
    await waitFor(() => text().includes("0 of 1 messages handed over"));
    expect(starts()[0]!.input).toEqual(starts()[1]!.input);
  });

  test("stop, continue with a fresh operation, and end", async () => {
    mount("laeuft");
    await click("Stop");
    await waitFor(() => text().includes("7 of 12 messages are handed over and stay that way. 5 are waiting."));
    const cancel = requests.find((request) => request.path.endsWith("/actions/core/code.event.catchup.cancel"));
    expect(cancel?.input).toEqual({ operationId: "00000000-0000-4000-8000-0000000000aa" });
    await click("Continue");
    await waitFor(() => text().includes("handed over. You can leave this page"));
    const resume = requests.find((request) => request.path.endsWith("/actions/core/code.event.catchup.resume"));
    expect(resume?.input.operationId).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(resume?.input.newOperationId).not.toBe("00000000-0000-4000-8000-0000000000aa");
    dispose();
    dom.root.textContent = "";
    mount("angehalten");
    await click("End");
    await waitFor(() => text().includes("Load preview"));
    expect(location.search).not.toContain("operation=");
  });

  test("after a partial failure the remaining messages are tried again with the saved snapshot", async () => {
    mount("teilfehler");
    expect(text()).toContain("Check access");
    await click("Try the 2 again");
    await waitFor(() => text().includes("handed over. You can leave this page"));
    const resume = requests.find((request) => request.path.endsWith("/actions/core/code.event.catchup.resume"));
    expect(resume?.input.operationId).toBe("00000000-0000-4000-8000-0000000000aa");
  });

  test("a stale preview loads again with the version that is now switched on", async () => {
    mount("veraltet");
    expect(text()).toContain("The preview no longer applies: version 5 is switched on now.");
    await click("Reload preview");
    await waitFor(() => text().includes("Apply to 1 message"));
    expect(text()).toContain("with version 5");
    expect(location.search).toContain("preview=00000000-0000-4000-8000-000000000005");
  });
}
