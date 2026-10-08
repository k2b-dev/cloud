import { expect, spyOn, test } from "bun:test";
import type { AdminMailRecord, MailPage } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), SendLog: (await import("./SendLog")).SendLog };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const flush = async () => {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
};
const row = (subject: string): AdminMailRecord => ({
  id: crypto.randomUUID(),
  appId: "inventory",
  profile: "alerts",
  to: ["reader@example.org"],
  subject,
  attachments: [],
  status: "sent",
  failures: [],
  attempts: 1,
  createdAt: "2026-10-08T00:00:00.000Z",
});
const page = (subject: string, nextCursor?: string): MailPage<AdminMailRecord> => ({
  items: [row(subject)],
  page: 1,
  perPage: 25,
  total: 1,
  hasNext: !!nextCursor,
  ...(nextCursor ? { nextCursor } : {}),
});

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("a deferred load-more response cannot append rows or a cursor after the filter changes", async () => {
    const dom = createDomTestHarness();
    const { ui, SendLog } = modules!;
    delegateEvents(["input", "click"]);
    const more = Promise.withResolvers<Response>();
    const filtered = Promise.withResolvers<Response>();
    const requests: URL[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
          requests.push(url);
          if (url.searchParams.get("cursor") === "old-cursor") return more.promise;
          if (url.searchParams.get("recipient") === "new@example.org" && !url.searchParams.has("cursor")) return filtered.promise;
          throw new Error(`Unexpected send-log request: ${url}`);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const timer = spyOn(globalThis, "setTimeout");
    const dispose = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(SendLog, {
              initial: { filter: {}, retention: { contentDays: 90, recordDays: 365 }, page: page("Initial row", "old-cursor") },
              apps: [],
            });
          },
        }),
      dom.root,
    );
    try {
      // DataTable requests more when its end is visible in the DOM harness.
      await flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.searchParams.get("cursor")).toBe("old-cursor");
      const input = dom.root.querySelector<HTMLInputElement>('input[aria-label="Search recipients"]')!;
      input.value = "new@example.org";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
      const search = timer.mock.calls.find(([, delay]) => delay === 300)?.[0];
      if (!search) throw new Error("Expected the recipient-search debounce");
      search();
      await flush();
      expect(requests).toHaveLength(2);
      expect(requests[1]!.searchParams.get("recipient")).toBe("new@example.org");
      expect(requests[1]!.searchParams.has("cursor")).toBe(false);

      more.resolve(Response.json(page("Stale row", "stale-cursor")));
      await flush();
      expect(dom.root.textContent).not.toContain("Stale row");
      // The new first page is still pending: no request may use the previous page's cursor.
      expect(requests).toHaveLength(2);

      filtered.resolve(Response.json(page("Current row")));
      await flush();
      expect(dom.root.textContent).toContain("Current row");
      expect(dom.root.textContent).not.toContain("Initial row");
      expect(dom.root.textContent).not.toContain("Stale row");
      expect(requests).toHaveLength(2);
    } finally {
      dispose();
      timer.mockRestore();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
