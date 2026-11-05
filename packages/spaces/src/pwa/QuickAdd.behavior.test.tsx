import { afterEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { Outgoing } from "./create";
import type { QuickAddTarget } from "./QuickAdd";

/** Invented demo data. */
const workshop: QuickAddTarget = {
  shortId: "Space1",
  name: "Workshop",
  color: "#4d7c0f",
  statuses: [
    { id: "Col000", name: "Done before", color: "#16a34a", done: true },
    { id: "Col001", name: "Inbox", color: "#94a3b8", done: false },
    { id: "Col002", name: "Doing", color: "#2563eb", done: false },
  ],
  templates: [],
};
const me = { id: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f", kind: "user" as const, displayName: "Mia Muster", avatarHash: null };

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
let route: (call: Call) => Response | "offline" = () => Response.json({ message: "Unavailable" }, { status: 503 });
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const answer = route(call);
      if (answer === "offline") throw new TypeError("Failed to fetch");
      return answer;
    },
    { preconnect: globalThis.fetch.preconnect },
  ),
);

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ui: await import("@k2b/ui"),
      quick: await import("./QuickAdd"),
      Composer: (await import("./Composer")).default,
      create: await import("./create"),
      drafts: (await import("@k2b/cloud/browser/pwa-drafts")).pwaDrafts,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

let dom: DomTestHarness | undefined;
let dispose = () => {};
afterEach(() => {
  dispose();
  dom?.cleanup();
  calls.length = 0;
});

const mount = (options: { online?: boolean; spaces?: boolean } = {}) => {
  const { ui } = modules!;
  dom = createDomTestHarness();
  delegateEvents(["click", "input", "keydown"]);
  const sent: { spaceShortId: string; body: Outgoing["body"] }[] = [];
  let closed = 0;
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(modules!.Composer, {
            userId: me.id,
            me,
            target: workshop,
            spaces: options.spaces
              ? [{ shortId: "Space1", name: "Workshop", color: "#4d7c0f", openCount: 2, canWrite: true, pinned: false }]
              : undefined,
            online: options.online ?? true,
            dateConfig: { locale: "en", timeZone: "UTC" },
            onSubmit: (task: { spaceShortId: string; body: Outgoing["body"] }) => sent.push(task),
            onClose: () => {
              closed += 1;
            },
          });
        },
      }),
    dom.root,
  );
  const field = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  const type = (text: string) => {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (name: string, init: KeyboardEventInit = {}) =>
    field.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
  return { root: dom.root, field, type, key, sent, closed: () => closed };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("Enter adds the task in the first open status with a fresh request key, and keeps the field open for the next", () => {
    const page = mount();
    const send = page.root.querySelector<HTMLButtonElement>('button[aria-label="Add task"]')!;
    expect(send.disabled).toBe(true);
    page.type("Fix the armrest");
    expect(send.disabled).toBe(false);
    page.key("Enter");
    page.type("Order foam");
    page.key("Enter", { isComposing: true });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ spaceShortId: "Space1", body: { title: "Fix the armrest", columnId: "Col001" } });
    expect(page.sent[0]!.body.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    page.key("Enter");
    expect(page.sent[1]!.body.requestKey).not.toBe(page.sent[0]!.body.requestKey);
    expect(page.field.value).toBe("");
    expect(page.root.textContent).toContain("Inbox");
  });

  test("from My tasks the task is the person's, and the Space chip names where it goes", () => {
    const page = mount({ spaces: true });
    expect(page.root.textContent).toContain("Workshop");
    expect(page.root.textContent).toContain("Me");
    page.type("Call the customer");
    page.key("Enter");
    expect(page.sent[0]!.body.assigneeIds).toEqual([me.id]);
  });

  test("offline, Add is off and says why; the text stays as a draft on the device after closing", () => {
    const page = mount({ online: false });
    page.type("Fix the armrest");
    expect(page.root.querySelector<HTMLButtonElement>('button[aria-label="Add task"]')!.disabled).toBe(true);
    expect(page.root.textContent).toContain("Offline. Adding works again with a connection. Your text stays here.");
    page.key("Escape");
    expect(page.closed()).toBe(1);
    // The draft stays on the device for this account, where the field reads it when it opens again.
    expect(modules!.drafts.read(me.id, "spaces.quick-add:Space1")).toBe("Fix the armrest");
  });

  test("a create without an answer is not confirmed and may repeat; a refusal names its reason and stays final", async () => {
    const { sendCreate } = modules!.create;
    const body = { title: "Fix the armrest", columnId: "Col001", requestKey: "key-1" };
    route = () => "offline";
    expect(await sendCreate("Space1", body, "refused")).toEqual({ kind: "unconfirmed" });
    route = () => Response.json({ message: "Down" }, { status: 502 });
    expect(await sendCreate("Space1", body, "refused")).toEqual({ kind: "unconfirmed" });
    route = () => Response.json({ message: "Forbidden" }, { status: 403 });
    expect(await sendCreate("Space1", body, "You can no longer add tasks.")).toEqual({
      kind: "refused",
      reason: "You can no longer add tasks.",
    });
    route = () => Response.json({ message: "This request key was used for another task." }, { status: 409 });
    expect(await sendCreate("Space1", body, "refused")).toEqual({ kind: "refused", reason: "This request key was used for another task." });
    route = () => Response.json({ id: "Item01", title: "Fix the armrest" });
    expect(await sendCreate("Space1", body, "refused")).toMatchObject({ kind: "created", item: { id: "Item01" } });
    // Every try sends the same body with the same key, so the server keeps one task.
    expect(new Set(calls.map((call) => JSON.stringify(call.body))).size).toBe(1);
    expect(calls.every((call) => call.method === "POST" && call.path === "/api/spaces/Space1/items")).toBe(true);
  });

  test("an outgoing row shows saving, not confirmed with ↻, or the reason", () => {
    const { ui, quick } = modules!;
    dom = createDomTestHarness();
    delegateEvents(["click"]);
    const resent: string[] = [];
    const entry = (state: Outgoing["state"], reason?: string): Outgoing => ({
      key: state,
      spaceShortId: "Space1",
      statusId: "Col001",
      title: "Fix the armrest",
      body: { title: "Fix the armrest", columnId: "Col001", requestKey: state },
      state,
      reason,
    });
    dispose = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale: "en",
          get children() {
            return [entry("saving"), entry("unconfirmed"), entry("refused", "You can no longer add tasks in “Workshop”.")].map((item) =>
              createComponent(quick.OutgoingRow, { entry: item, onResend: (key: string) => resent.push(key) }),
            );
          },
        }),
      dom.root,
    );
    const rows = [...dom.root.querySelectorAll(".spaces-pwa__row")].map((row) => row.textContent);
    expect(rows).toEqual([
      "Fix the armrestAdding …",
      "Fix the armrestNot confirmed. ↻ sends it again without adding it twice.",
      "Fix the armrestYou can no longer add tasks in “Workshop”.",
    ]);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Add “Fix the armrest” again"]')!.click();
    expect(resent).toEqual(["unconfirmed"]);
  });
}
