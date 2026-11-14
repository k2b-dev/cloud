import { afterEach, beforeEach, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await Promise.all([import("./MailCodeTools"), import("@k2b/ui")]);
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const uuid = "00000000-0000-4000-8000-000000000001";
const time = "2026-11-01T12:00:00.000Z";
const event = {
  id: uuid,
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time,
  subject: { type: "mail.message", id: "Msg123" },
  place: { type: "mail.mailbox", id: "Box123" },
  data: { receiptId: uuid },
};
const mock = {
  operation: "mail.message.read",
  target: null,
  input: { id: "Msg123" },
  replies: [{ ok: true, data: { subject: "Real message" } }],
};
const progress = {
  operationId: uuid,
  versionId: uuid,
  status: "queued",
  total: 1,
  dispatched: 0,
  failureCount: 0,
  lastError: null,
  createdAt: time,
  updatedAt: time,
};
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

if (isServer) test.skip("Mail Code controls run in the browser-conditions process", () => {});
else {
  const [{ default: MailCodeTools }, { LocaleProvider }] = modules!;
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let requests: { path: string; input: Record<string, unknown> }[];
  let loseStart = false;
  let rejectStart = false;
  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    delegateEvents(["click"]);
    requests = [];
    loseStart = false;
    rejectStart = false;
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(url), "http://localhost").pathname;
        const body = JSON.parse(String(init?.body));
        requests.push({ path, input: body.input ?? body });
        const reply = (data: object) => Response.json({ data });
        if (path.endsWith("/queries/mail/message.catchup"))
          return reply({ cutoffAt: time, items: [{ title: "Real message", event }], nextCursor: null });
        if (path.endsWith("/queries/mail/message.event-preview")) return reply({ event, mock });
        if (path === "/api/code/authoring/simulateEvent")
          return Response.json({ version: 1, mode: "simulate", ok: false, error: "missing_mock", diagnostics: [], cases: [] });
        if (path.endsWith("/actions/core/code.event.catchup")) {
          if (rejectStart) {
            rejectStart = false;
            return Response.json({ code: "CONFLICT", message: "Version changed" }, { status: 409 });
          }
          if (loseStart) {
            loseStart = false;
            throw new Error("response lost");
          }
          return reply({ ...progress, operationId: body.input.operationId });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailCodeTools mailboxId="Box123" codeId="c_mail0001" versionId={uuid} folders={[]} />
        </LocaleProvider>
      ),
      dom.root,
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
  const button = (label: string) => {
    const found = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  };
  const select = async () => {
    const count = requests.length;
    button("Select messages").click();
    await waitFor(
      () => requests.length > count && dom.root.textContent!.includes("1 messages selected") && !button("Select messages").disabled,
    );
  };
  test("real-message preview only reads the fixture and invokes fake simulation, showing a stopped preview", async () => {
    await select();
    button("Preview without effects").click();
    await waitFor(() => dom.root.textContent!.includes("missing_mock"));
    expect(requests.map((request) => request.path)).toEqual([
      "/api/capabilities/v1/queries/mail/message.catchup",
      "/api/capabilities/v1/queries/mail/message.event-preview",
      "/api/code/authoring/simulateEvent",
    ]);
    expect(requests[2]!.input).toMatchObject({ codeId: "c_mail0001", versionId: uuid, event, mocks: [mock] });
  });
  test("a rejected start can be replaced by a fresh selection and operation", async () => {
    await select();
    rejectStart = true;
    button("Catch up").click();
    await waitFor(() => dom.root.textContent!.includes("Version changed"));
    await select();
    button("Catch up").click();
    await waitFor(() => dom.root.textContent!.includes("0 of 1 messages admitted"));
    const starts = requests.filter((request) => request.path.endsWith("/actions/core/code.event.catchup"));
    expect(starts).toHaveLength(2);
    expect(starts[0]!.input.operationId).not.toBe(starts[1]!.input.operationId);
  });
  test("a lost catch-up response preserves the exact operation and snapshot for deliberate retry", async () => {
    await select();
    loseStart = true;
    button("Catch up").click();
    await waitFor(() => !!dom.root.querySelector('[role="alert"]'));
    button("Catch up").click();
    await waitFor(() => dom.root.textContent!.includes("0 of 1 messages admitted"));
    const starts = requests.filter((request) => request.path.endsWith("/actions/core/code.event.catchup"));
    expect(starts).toHaveLength(2);
    expect(starts[0]!.input).toEqual(starts[1]!.input);
    expect(starts[1]!.input).toMatchObject({ versionId: uuid, events: [event] });
    expect(dom.root.textContent).toContain("Cancel catch-up");
  });
}
