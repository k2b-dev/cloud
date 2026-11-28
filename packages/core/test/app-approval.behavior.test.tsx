import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const id = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
// A fixed past date for when a listed device was paired or removed; nothing compares it with today.
const _pairedAt = "2026-10-01T09:00:00.000Z";
// real clock: the dialogs count these expiries down on the real clock and its timers.
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
const login = () => ({
  requestId: id,
  browserSecret: "A".repeat(43),
  comparison: "123456",
  expiresAt: fromNow(300_000),
  pollAfterSeconds: 5,
});
const pairing = () => ({
  protocol: "cloud-app-approval-v1",
  issuer: "http://localhost",
  pairingId: id,
  secret: "c".repeat(43),
  expiresAt: fromNow(300_000),
});
const start = mock(async () => Response.json(login(), { status: 202 }));
const status = mock(async () => Response.json({ state: "pending", pollAfterSeconds: 5 }));
const complete = mock(async () => new Response(null, { status: 204 }));
const pairStart = mock(async () => Response.json(pairing(), { status: 201 }));
const inspection = mock(async () =>
  Response.json({ state: "claimed", name: "Phone", deviceId, comparison: "654321", userId: id, approval: null }),
);
const confirm = mock(async () => Response.json({ deviceId, approval: null }));
const cancel = mock(async () => new Response(null, { status: 204 }));
const changeId = "00000000-0000-4000-8000-000000000003";
const later = () => fromNow(300_000);
const update = mock(async () => Response.json({ state: "pending", changeId, expiresAt: later() }));
const changeStatus = mock(async () => Response.json({ changeId, endSessions: true, state: "pending", expiresAt: later() }));
const changeCancel = mock(async () => new Response(null, { status: 204 }));
const list = mock(async () => Response.json({ items: [], nextCursor: null }));
const logout = mock(async () => new Response(null, { status: 204 }));
const passwordLogin = mock(async () => new Response(null, { status: 204 }));
if (!isServer)
  mock.module("@k2b/cloud/clients/core", () => ({
    apiClient: {
      auth: {
        login: { $post: passwordLogin },
        logout: { $post: logout },
        "app-approval": {
          v1: {
            login: { start: { $post: start }, status: { $post: status }, complete: { $post: complete } },
            manage: {
              pairings: {
                start: { $post: pairStart },
                status: { $post: inspection },
                confirm: { $post: confirm },
                cancel: { $post: cancel },
              },
              devices: { $get: list, update: { $post: update } },
              "device-changes": { status: { $post: changeStatus }, cancel: { $post: changeCancel } },
            },
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
/** Waits, with a bounded deadline, for what a dialog shows after its next status read on the real five-second poll. */
const _eventually = async (check: () => boolean, timeoutMs = 8_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("The expected state did not appear in time");
    await Bun.sleep(50);
    await flush();
  }
};
/** The revocation phase on screen; the others stay in the dialog, hidden, to keep its size. */
const _shown = (dialog: Element | null) => dialog?.querySelector(".app-revoke-phases > :not([aria-hidden])")?.textContent ?? "";
const _button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!;

describe("Cloud app approval UI", () => {
  if (isServer) {
    test.skip("requires browser conditions and DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    for (const fn of [
      start,
      status,
      complete,
      pairStart,
      inspection,
      confirm,
      cancel,
      update,
      changeStatus,
      changeCancel,
      list,
      logout,
      passwordLogin,
    ])
      fn.mockClear();
  });
  test("switching to the recovery method discards the pending browser credential", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:login:/", JSON.stringify(login()));
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(
      () => createComponent(Login, { category: "login", fallback: { href: "/auth/login?credential=legacy", label: "Email recovery" } }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/auth/login?credential=legacy"]')!;
    expect(dom.root.querySelector(".text-center .tabular-nums")?.textContent).toBe("123456");
    expect(dom.root.textContent).not.toContain("Stopping here does not delete");
    link.addEventListener("click", (event) => event.preventDefault());
    link.click();
    await flush();
    expect(dom.window.sessionStorage.getItem("cloud.app-login:login:/")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
  test("expired saved login requests are discarded without contacting the server", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:guest:/", JSON.stringify({ ...login(), expiresAt: "2020-01-01T00:00:00.000Z" }));
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(() => createComponent(Login, { category: "guest" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.window.sessionStorage.getItem("cloud.app-login:guest:/")).toBeNull();
    expect(status).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  test("login resumes in the originating tab and a lost completion response is never retried", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:freeipa:/", JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "approved", pollAfterSeconds: 5 }));
    complete.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    let dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.root.textContent).toContain("123456");
    expect(start).not.toHaveBeenCalled();
    await Bun.sleep(5100);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem("cloud.app-login:freeipa:/")).toBeNull();
    expect(dom.root.textContent).toContain("Sign-in could not be confirmed");
    dispose();
    dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    await flush();
    expect(dom.root.textContent).not.toContain("123456");
    expect(complete).toHaveBeenCalledTimes(1);
  }, 15000);
  test("foreground reads start at least five seconds apart, pause while hidden, and abort on disposal", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const { pollApproval } = await import("../src/pages/app-approval/client");
    let hidden = true;
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    let signal: AbortSignal | undefined;
    let answer = (_again: boolean) => {};
    const starts: number[] = [];
    const t0 = Date.now();
    const read = mock((value: AbortSignal) => {
      signal = value;
      starts.push(Date.now() - t0);
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    const stop = pollApproval(read, () => true, 0);
    cleanup = () => {
      stop();
      dom.cleanup();
      jest.useRealTimers();
    };
    jest.advanceTimersByTime(10_000);
    expect(read).not.toHaveBeenCalled();
    hidden = false;
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    jest.advanceTimersByTime(1); // zero-delay timers take one millisecond
    expect(starts).toEqual([10_001]);
    // A read the server held for a full interval is followed at once.
    jest.advanceTimersByTime(5_000);
    answer(true);
    await flush();
    jest.advanceTimersByTime(1);
    expect(starts).toEqual([10_001, 15_002]);
    // A quick answer waits for the rest of the interval.
    jest.advanceTimersByTime(1_000);
    answer(true);
    await flush();
    jest.advanceTimersByTime(3_999);
    expect(starts).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(starts).toEqual([10_001, 15_002, 20_002]);
    stop();
    expect(signal?.aborted).toBe(true);
  });
  test("an approval continues at once and the form never returns before navigation", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const t0 = Date.now();
    dom.window.sessionStorage.setItem("cloud.app-login:login:/app/files", JSON.stringify(login()));
    let decide = (_response: Response) => {};
    status.mockImplementation(
      // Long poll: the server answers when the app decides.
      () =>
        new Promise<Response>((resolve) => {
          decide = resolve;
        }),
    );
    let navigatedAt: number | undefined;
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => {
      navigatedAt = Date.now() - t0;
    });
    const forms: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeName === "FORM" || (node as unknown as Element).querySelector?.("form")) forms.push(node as unknown as Node);
    });
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(
      () =>
        createComponent(Login, {
          category: "login",
          redirectTo: "/app/files",
          fallback: { href: "/auth/login?credential=legacy", label: "Email recovery" },
        }),
      dom.root,
    );
    cleanup = () => {
      observer.disconnect();
      dispose();
      dom.cleanup();
      jest.useRealTimers();
    };
    await flush();
    expect(dom.root.textContent).toContain("123456");
    observer.observe(dom.root, { childList: true, subtree: true });
    jest.advanceTimersByTime(1);
    expect(status).toHaveBeenCalledTimes(1);
    // The app approves two seconds later; no further read or timer is needed to continue.
    jest.advanceTimersByTime(2_000);
    const decidedAt = Date.now() - t0;
    decide(Response.json({ state: "approved", pollAfterSeconds: 5 }));
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/auth/continue?redirectTo=%2Fapp%2Ffiles");
    expect(navigatedAt).toBe(decidedAt);
    // Navigation takes its time; the page keeps the confirmed state meanwhile.
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(dom.root.querySelector("form")).toBeNull();
    expect(forms).toEqual([]);
    expect(dom.root.textContent).toContain("Signed in – continuing…");
    expect(dom.root.textContent).not.toContain("Email recovery");
    expect(status).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["freeipa", ["login_freeipa_app=1", "login_method=ipa"], true],
    ["login", ["login_method=login"], true],
    ["guest", ["login_method=guest"], false],
  ] as const)("a completed %s app sign-in reopens that account type next time", async (category, remembered, withApp) => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem(`cloud.app-login:${category}:/`, JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "approved", pollAfterSeconds: 5 }));
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const { useAppSignIn } = await import("../src/pages/app-approval/availability");
    const { readLoginMethodFromCookieHeader } = await import("@k2b/cloud/shared");
    const { DEFAULT_ACCOUNT_CATEGORY_POLICY, resolveAccountCategoryLogin } = await import("@k2b/cloud/contracts");
    const dispose = render(() => createComponent(Login, { category }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(20); // the first status read starts on a zero-delay timer
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    // Only FreeIPA keeps a memory of the app, and no cookie names an account.
    const cookieHeader = dom.document.cookie;
    expect(cookieHeader.split("; ").sort()).toEqual([...remembered]);
    // The next request carries these cookies; the sign-in page resolves them like this.
    const { active } = resolveAccountCategoryLogin({
      policy: DEFAULT_ACCOUNT_CATEGORY_POLICY,
      freeIpaEnabled: true,
      remembered: readLoginMethodFromCookieHeader(cookieHeader),
    });
    expect(active).toBe(category);
    expect(useAppSignIn({ configured: true, category: active, cookieHeader })).toBe(withApp);
  });
  test("a lost or denied app sign-in remembers nothing", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:freeipa:/", JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "approved", pollAfterSeconds: 5 }));
    complete.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    let dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(20);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(dom.document.cookie).toBe("");
    dispose();
    dom.window.sessionStorage.setItem("cloud.app-login:freeipa:/", JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "denied", pollAfterSeconds: 5 }));
    dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    await Bun.sleep(20);
    await flush();
    expect(dom.root.textContent).toContain("Sign-in was declined");
    expect(dom.document.cookie).toBe("");
  });
  test("a FreeIPA password sign-in returns the browser to the password; a rejected one changes nothing", async () => {
    const dom = createDomTestHarness();
    const { FREEIPA_APP_SIGN_IN_COOKIE, useAppSignIn } = await import("../src/pages/app-approval/availability");
    const { default: PasswordLogin } = await import("../src/pages/auth/LoginForm.island");
    const opensWithApp = () => useAppSignIn({ configured: true, category: "freeipa", cookieHeader: dom.document.cookie });
    dom.document.cookie = `${FREEIPA_APP_SIGN_IN_COOKIE}=1; path=/`;
    expect(opensWithApp()).toBe(true);
    const dispose = render(() => createComponent(PasswordLogin, { defaultUsername: "mira" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const submit = async () => {
      dom.root
        .querySelector("form")!
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await flush();
    };
    passwordLogin.mockImplementationOnce(async () => Response.json({ message: "Invalid credentials" }, { status: 401 }));
    await submit();
    expect(passwordLogin).toHaveBeenCalledTimes(1);
    expect(dom.root.textContent).toContain("Invalid credentials");
    expect(opensWithApp()).toBe(true);
    await submit();
    expect(passwordLogin).toHaveBeenCalledTimes(2);
    // Read through the chooser: happy-dom drops a `max-age=0` cookie only on the next millisecond.
    expect(opensWithApp()).toBe(false);
    expect(dom.document.cookie).toContain("login_method=ipa");
    expect(dom.window.location.pathname).toBe("/auth/continue");
  });
});
