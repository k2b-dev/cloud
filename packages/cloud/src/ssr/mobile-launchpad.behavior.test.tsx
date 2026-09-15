import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test("the public mobile launcher keeps profile actions and filters apps without nesting a panel", async () => {
  const dom = createDomTestHarness();
  dom.window.innerWidth = 390;
  const { default: AppLaunchpad } = await import("./AppLaunchpad.island");
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
    await Bun.sleep(20);
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
