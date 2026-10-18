import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test("the public launcher opens once during loading and can open again afterwards", async () => {
  const dom = createDomTestHarness();
  const reload = await import("../browser/reload");
  const surface = await import("./launchpad-surface");
  const { openAppLaunchpad, setAppLaunchpadContext } = await import("./app-launchpad");
  const pending = Promise.withResolvers<void>();
  const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
    await pending.promise;
    return loader();
  });
  const open = spyOn(surface, "openLaunchpadSurface").mockImplementation(() => {});
  setAppLaunchpadContext([{ id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail" }]);
  let first: ReturnType<typeof openAppLaunchpad>;
  try {
    first = openAppLaunchpad();
    // A second click through the global entry point arrives while the first load runs.
    window.cloud?.openAppLaunchpad?.();
    await Bun.sleep(10);
    expect(load).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    pending.resolve();
    await first;
    expect(open).toHaveBeenCalledTimes(1);
    await openAppLaunchpad();
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve();
    await first;
    load.mockRestore();
    open.mockRestore();
    dom.cleanup();
  }
});

test("the public mobile launcher keeps profile actions and filters apps without nesting a panel", async () => {
  const dom = createDomTestHarness();
  dom.window.innerWidth = 390;
  const { AppLaunchpadButton: AppLaunchpad } = await import("./app-launchpad");
  const dispose = render(
    () =>
      createComponent(AppLaunchpad, {
        variant: "header",
        apps: [
          { id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail" },
          { id: "notes", label: "Notebooks", href: "/app/notebooks", iconClass: "ti ti-notebook" },
        ],
        legalLinks: [{ label: "Profile", href: "/me" }],
        profile: { name: "Test user", theme: "light" },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    for (let attempt = 0; !document.querySelector("dialog .cloud-mobile-profile") && attempt < 100; attempt += 1) await Bun.sleep(10);
    expect(document.querySelector("dialog .cloud-mobile-profile")).not.toBeNull();
    expect(document.querySelector("dialog .launchpad-panel")).toBeNull();
    expect(document.querySelectorAll('dialog a[href="/me"]')).toHaveLength(1);
    const input = document.querySelector<HTMLInputElement>("dialog input")!;
    input.value = "MAIL";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll("dialog .launchpad-app")).toHaveLength(1);
    expect(document.querySelector("dialog .launchpad-app")?.getAttribute("href")).toBe("/app/mail");
    input.value = "no-match";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll("dialog .launchpad-app")).toHaveLength(0);
    expect(document.querySelector("dialog")?.textContent).toContain("No matching apps.");
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

test("phone title and app-menu buttons open the same MobileNavigation sheet with the app menu", async () => {
  const dom = createDomTestHarness();
  dom.window.innerWidth = 390;
  const { AppLaunchpadButton } = await import("./app-launchpad");
  const snapshot = document.createElement("script");
  snapshot.type = "application/json";
  snapshot.setAttribute("data-cloud-workspace-navigation", "");
  snapshot.textContent = JSON.stringify({ label: "Team mailbox", items: [{ id: "inbox", label: "Inbox", href: "/app/mail/inbox" }] });
  dom.root.append(snapshot);
  const surface = await import("./launchpad-surface");
  const open = spyOn(surface, "openLaunchpadSurface");
  const dispose = render(
    () =>
      (["header", "title"] as const).map((variant) =>
        createComponent(AppLaunchpadButton, {
          variant,
          label: variant === "title" ? "Team mailbox" : "Open apps",
          apps: [{ id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail" }],
          legalLinks: [],
        }),
      ),
    dom.root,
  );
  try {
    const buttons = dom.root.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[1]!.textContent).toContain("Team mailbox");
    expect(buttons[1]!.getAttribute("aria-haspopup")).toBe("dialog");
    for (const button of buttons) {
      button.click();
      for (let attempt = 0; !document.querySelector('dialog a[href="/app/mail/inbox"]') && attempt < 100; attempt++) await Bun.sleep(10);
      expect(document.querySelector('dialog a[href="/app/mail/inbox"]')?.textContent).toContain("Inbox");
      expect(document.querySelector("dialog")?.textContent).toContain("All apps");
      window.dispatchEvent(new Event("pagehide"));
      for (let attempt = 0; document.querySelector("dialog") && attempt < 100; attempt++) await Bun.sleep(10);
      expect(document.querySelector("dialog")).toBeNull();
      await Bun.sleep(20);
    }
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0]).toEqual(open.mock.calls[1]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    await Bun.sleep(20);
    open.mockRestore();
    dispose();
    dom.cleanup();
  }
});

test("opening without arguments reads the shared shell payload and validates the mobile App action", async () => {
  const dom = createDomTestHarness();
  dom.window.innerWidth = 390;
  const { openAppLaunchpad } = await import("./app-launchpad");
  const script = dom.document.createElement("script");
  script.id = "cloud-shell-data";
  script.type = "application/json";
  script.textContent = JSON.stringify({
    apps: [{ id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail", match: "/app/mail", defaultVisible: true }],
    legalLinks: [],
    profile: { name: "Test user", appHref: "/unexpected" },
    theme: "light",
    searchLinks: {},
  });
  dom.document.body.append(script);
  try {
    openAppLaunchpad();
    expect(window.__cloudAppLaunchpad?.apps[0]?.id).toBe("mail");
    expect(window.__cloudAppLaunchpad?.profile).toEqual({ name: "Test user", theme: "light" });
    for (let attempt = 0; !document.querySelector("dialog .cloud-mobile-profile") && attempt < 100; attempt += 1) await Bun.sleep(10);
    expect(document.querySelector('dialog a[href="/app/mail"]')).not.toBeNull();
    expect(document.querySelector('dialog a[href="/unexpected"]')).toBeNull();
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    await Bun.sleep(20);
    dom.cleanup();
  }
});
