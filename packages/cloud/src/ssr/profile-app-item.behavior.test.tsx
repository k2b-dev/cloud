import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const openMobileMenu = async (profile: { name: string; theme: "light"; appHref?: string }) => {
  const dom = createDomTestHarness();
  dom.window.innerWidth = 390;
  const { default: AppLaunchpad } = await import("./AppLaunchpad.island");
  const dispose = render(
    () => createComponent(AppLaunchpad, { variant: "header", apps: [], legalLinks: [{ label: "Profile", href: "/me" }], profile }),
    dom.root,
  );
  dom.root.querySelector<HTMLButtonElement>("button")!.click();
  await Bun.sleep(20);
  return async () => {
    window.dispatchEvent(new Event("pagehide"));
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  };
};

test("the mobile profile actions offer the App item only while the mobile app runs", async () => {
  let close = await openMobileMenu({ name: "Test user", theme: "light", appHref: "/me/app" });
  try {
    const item = document.querySelector<HTMLAnchorElement>('dialog .cloud-mobile-profile a[href="/me/app"]');
    expect(item?.textContent).toContain("App");
    expect(item?.querySelector(".ti-device-mobile")).not.toBeNull();
  } finally {
    await close();
  }
  close = await openMobileMenu({ name: "Test user", theme: "light" });
  try {
    expect(document.querySelector('dialog a[href="/me/app"]')).toBeNull();
  } finally {
    await close();
  }
});
