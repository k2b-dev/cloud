import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

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
    searchHelpApps: [],
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
