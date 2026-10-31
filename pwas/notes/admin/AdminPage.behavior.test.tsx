import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("login refreshes CSRF after expiry, keeps its form mounted, and explains password failures", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  let sessionCalls = 0;
  const submittedTokens: (string | null)[] = [];
  let finishLogin: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("session")) return Response.json({ authenticated: false, csrf: `fresh-${++sessionCalls}` });
      submittedTokens.push(new Headers(init?.headers).get("x-csrf-token"));
      return new Promise<Response>((resolve) => {
        finishLogin = resolve;
      });
    },
    { preconnect: original.preconnect },
  );
  const { AdminPage } = await import("./AdminPage");
  const { LocaleProvider } = await import("@k2b/ui");
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AdminPage />
      </LocaleProvider>
    ),
    dom.root,
  );
  try {
    await settle();
    const input = dom.root.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "fixture-password";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = dom.root.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(sessionCalls).toBe(2);
    expect(submittedTokens.at(-1)).toBe("fresh-2");
    expect(dom.root.querySelector("form")).toBe(form);
    expect(dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    finishLogin!(Response.json({ code: "unauthorized" }, { status: 401 }));
    await settle();
    expect(dom.root.textContent).toContain("Das Passwort ist falsch");
    expect(input.value).toBe("fixture-password");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(submittedTokens.at(-1)).toBe("fresh-3");
    finishLogin!(Response.json({ code: "rate_limited" }, { status: 429 }));
    await settle();
    expect(dom.root.textContent).toContain("Zu viele Anmeldeversuche");
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});
