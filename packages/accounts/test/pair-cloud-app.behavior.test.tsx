import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ID = "8f0b3c39-4a7e-4a37-9bdb-1f0f6b0b8f11";
const USER = "7bd9706e-6c70-4dd5-946f-0caac02bfc2a";
const expiresAt = "2026-10-23T12:10:00.000Z";
const claimUntil = "2026-10-23T12:05:00.000Z";
const secret = "A".repeat(43);
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), Pair: (await import("../src/frontend/users/detail/PairCloudApp.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const waitFor = async (condition: () => boolean) => {
  for (let n = 0; n < 300; n++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Expected dialog state did not arrive: ${document.body.textContent}`);
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const text = (dom: DomTestHarness) => dom.document.querySelector("dialog")?.textContent ?? "";

if (isServer) test.skip("requires browser conditions", () => {});
else {
  let dom: DomTestHarness;
  let dispose = () => {};
  let state = "pending";
  let startError: string | undefined;
  let confirmations = 0;
  let cancellations = 0;
  let starts = 0;
  let attemptsLeft = 3;
  let lostConfirmation = false;
  let copyFails = false;
  let copied = "";
  beforeEach(() => {
    setSystemTime(NOW);
    dom = createDomTestHarness();
    delegateEvents(["click", "input"]);
    dom.window.history.replaceState(null, "", `/app/accounts/users/${USER}?search=Ada`);
    state = "pending";
    startError = undefined;
    confirmations = 0;
    cancellations = 0;
    starts = 0;
    attemptsLeft = 3;
    lostConfirmation = false;
    copyFails = false;
    copied = "";
    const original = globalThis.setTimeout;
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) =>
      original(callback, delay === 5000 ? 10 : delay)) as typeof setTimeout);
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (link: string) => {
          if (copyFails) throw new Error("denied");
          copied = link;
        },
      },
    });
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
          const path = new URL(req.url).pathname;
          if (path.endsWith(`/users/${USER}/pairings`)) {
            starts++;
            return startError
              ? Response.json({ code: startError }, { status: startError === "LIMIT_REACHED" ? 429 : 403 })
              : Response.json({ id: ID, secret, claimUntil, expiresAt }, { status: 201 });
          }
          if (path.endsWith("/confirm")) {
            confirmations++;
            if (lostConfirmation) {
              state = "awaiting_device";
              return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
            }
            if (confirmations === 1) return Response.json({ code: "WRONG_CODE", attemptsLeft: 2 }, { status: 409 });
            state = "awaiting_device";
            return new Response(null, { status: 204 });
          }
          if (path.endsWith("/cancel")) {
            cancellations++;
            return new Response(null, { status: 204 });
          }
          if (path.endsWith(`/pairings/${ID}`))
            return Response.json({
              state,
              claimUntil,
              expiresAt,
              device: state === "pending" ? null : { name: "iPad", platform: "ios" },
              attemptsLeft,
            });
          return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
  });
  afterEach(() => {
    dispose();
    modules!.ui.dialogCore.close();
    dom.cleanup();
    setSystemTime();
    mock.restore();
  });
  const mount = (locale = "en", blocked = false) => {
    const { ui, Pair } = modules!;
    dispose = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale,
          get children() {
            return createComponent(Pair, { userId: USER, name: "Ada", blocked });
          },
        }),
      dom.root,
    );
  };
  const typeCode = () => {
    const inputs = [...dom.document.querySelectorAll<HTMLInputElement>("dialog .k2b-pin-input input")];
    for (const [i, input] of inputs.entries()) {
      input.value = "123456"[i]!;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    }
  };
  for (const locale of ["en", "de"]) {
    test(`admin dialog shows QR, instructions, persistent wrong code, device wait and rejection in ${locale}`, async () => {
      mount(locale);
      button(dom, locale === "de" ? "Cloud-App koppeln" : "Pair Cloud app")!.click();
      await waitFor(() => Boolean(dom.document.querySelector("dialog img")));
      expect(text(dom)).toContain(locale === "de" ? "Cloud-App für Ada koppeln" : "Pair Cloud app for Ada");
      expect(text(dom)).toContain(
        locale === "de"
          ? "Nicht Cloud Login. Das Gerät meldet sich danach als Ada an."
          : "Not Cloud Login. The device will then sign in as Ada.",
      );
      expect(dom.document.querySelectorAll("dialog ol li")).toHaveLength(3);
      expect(text(dom)).toContain("5:00");
      copyFails = true;
      button(dom, locale === "de" ? "Link kopieren" : "Copy link")!.click();
      await waitFor(() => text(dom).includes(locale === "de" ? "nicht kopiert" : "could not be copied"));
      copyFails = false;
      button(dom, locale === "de" ? "Link kopieren" : "Copy link")!.click();
      await waitFor(() => Boolean(copied));
      expect(copied).toBe(`http://localhost/pwa/#pair=${secret}`);
      state = "claimed";
      await waitFor(() => Boolean(dom.document.querySelector("dialog input")));
      typeCode();
      button(dom, locale === "de" ? "Code bestätigen" : "Confirm code")!.click();
      await waitFor(() => confirmations === 1);
      await waitFor(() => text(dom).includes(locale === "de" ? "Noch 2 Versuche." : "2 attempts left."));
      await Bun.sleep(30);
      expect(text(dom)).toContain(locale === "de" ? "Noch 2 Versuche." : "2 attempts left.");
      typeCode();
      button(dom, locale === "de" ? "Code bestätigen" : "Confirm code")!.click();
      await waitFor(() =>
        text(dom).includes(locale === "de" ? "Wartet, bis Ada am Gerät bestätigt." : "Waiting for Ada to confirm on the device."),
      );
      expect(text(dom)).not.toContain(locale === "de" ? "Gekoppelt:" : "Paired:");
      state = "rejected";
      await waitFor(() =>
        text(dom).includes(
          locale === "de" ? "Ada hat abgelehnt. Es wurde nichts gekoppelt." : "Ada rejected the pairing. Nothing was paired.",
        ),
      );
    });
    test(`success names the device and describes notification, audit and removal in ${locale}`, async () => {
      state = "completed";
      mount(locale);
      button(dom, locale === "de" ? "Cloud-App koppeln" : "Pair Cloud app")!.click();
      await waitFor(() => text(dom).includes(locale === "de" ? "Gekoppelt: iPad" : "Paired: iPad"));
      expect(text(dom)).toContain(
        locale === "de"
          ? "Ada bekommt eine Benachrichtigung. Die Kopplung steht im Protokoll."
          : "Ada will receive a notification. The pairing is recorded in the log.",
      );
      expect(text(dom)).toContain(locale === "de" ? "jederzeit in der Liste" : "from the list at any time");
    });
    test(`a blocked account shows a disabled action and its reason in ${locale}`, () => {
      mount(locale, true);
      expect(button(dom, locale === "de" ? "Cloud-App koppeln" : "Pair Cloud app")?.disabled).toBeTrue();
      expect(dom.root.textContent).toContain(
        locale === "de"
          ? "Adas Konto ist gesperrt. Entsperre es, um ein Gerät zu koppeln."
          : "Ada’s account is blocked. Unblock it to pair a device.",
      );
    });
  }
  for (const [stateName, expected] of [
    ["cancelled", "The pairing has expired"],
    ["rejected", "Nothing was paired"],
  ]) {
    test(`terminal state ${stateName} is visible`, async () => {
      state = stateName!;
      mount();
      button(dom, "Pair Cloud app")!.click();
      await waitFor(() => text(dom).includes(expected!));
    });
  }
  test("a consumed code with a lost answer reconciles to device waiting", async () => {
    state = "claimed";
    lostConfirmation = true;
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => Boolean(dom.document.querySelector("dialog input")));
    typeCode();
    button(dom, "Confirm code")!.click();
    await waitFor(() => text(dom).includes("Waiting for Ada to confirm on the device."));
    expect(text(dom)).not.toContain("Cloud could not be reached");
    expect(confirmations).toBe(1);
  });
  test("an exhausted code attempt limit ends the dialog flow", async () => {
    state = "cancelled";
    attemptsLeft = 0;
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => text(dom).includes("Too many wrong codes. The pairing has ended."));
    expect(dom.document.querySelector("dialog input")).toBeNull();
  });

  test("reloading resumes the same tab's pairing without saving its secret", async () => {
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => Boolean(dom.document.querySelector("dialog img")));
    const saved = dom.window.sessionStorage.getItem(`cloud.admin-pwa-pairing:${USER}`)!;
    expect(JSON.parse(saved)).toEqual({ id: ID, expiresAt });
    expect(saved).not.toContain(secret);
    dispose();
    modules!.ui.dialogCore.close();
    await waitFor(() => !dom.document.querySelector("dialog"));
    state = "claimed";
    mount();
    await waitFor(() => Boolean(dom.document.querySelector("dialog input")));
    expect(starts).toBe(1);
    expect(cancellations).toBe(0);
  });

  test("freshness failure links back to the same detail after signing in", async () => {
    startError = "REAUTHENTICATE";
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => text(dom).includes("Sign in again to pair a device."));
    const href = dom.document.querySelector<HTMLAnchorElement>('dialog a[href^="/auth/login"]')!.getAttribute("href")!;
    const redirect = new URL(href, "http://localhost").searchParams.get("redirectTo")!;
    expect(redirect).toBe(`/app/accounts/users/${USER}?search=Ada&pairCloudApp=1`);
  });
  test("closing an open dialog cancels its pairing", async () => {
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => Boolean(dom.document.querySelector("dialog img")));
    button(dom, "Close")!.click();
    await waitFor(() => cancellations === 1);
  });
  test("the target's account limit is explained", async () => {
    startError = "LIMIT_REACHED";
    mount();
    button(dom, "Pair Cloud app")!.click();
    await waitFor(() => text(dom).includes("account's pairing or device limit"));
  });
}
