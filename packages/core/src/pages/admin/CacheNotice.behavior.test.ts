import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (isServer) {
  test.skip("cache actions require browser conditions and Solid DOM preload", () => {});
} else {
  test("cache actions disable while pending, report failures, retry, and confirm with a toast", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const { default: CacheNotice } = await import("./CacheNotice.island");
    const { LocaleProvider, toast } = await import("@k2b/ui");
    const requests: Array<{ url: string; method: string | undefined }> = [];
    let respond: (response: Response) => void = () => {};
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }) as typeof fetch;
    const flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    try {
      for (const area of ["settings", "announcements"] as const) {
        const dispose = render(
          () =>
            createComponent(LocaleProvider, {
              locale: "de",
              get children() {
                return createComponent(CacheNotice, { area });
              },
            }),
          dom.root,
        );
        try {
          const button = dom.root.querySelector("button")!;
          expect(button.type).toBe("button");
          button.click();
          await flush();
          expect(button.disabled).toBe(true);
          expect(requests.at(-1)).toEqual({ url: `/api/admin/core/${area}/cache`, method: "DELETE" });
          respond(new Response("", { status: 503 }));
          await flush();
          expect(dom.root.textContent).toContain("Der Cache konnte nicht zurückgesetzt werden");
          expect(button.disabled).toBe(false);
          button.click();
          await flush();
          respond(Response.json({ success: true }));
          await flush();
          expect(dom.root.textContent).not.toContain("Cache zurückgesetzt.");
          expect(dom.document.body.textContent).toContain("Cache zurückgesetzt. Die Daten werden beim nächsten Aufruf neu geladen.");
          expect(button.disabled).toBe(false);
        } finally {
          dispose();
          toast.dismissAll();
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
