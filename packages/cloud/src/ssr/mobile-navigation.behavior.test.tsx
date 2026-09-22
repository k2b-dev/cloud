import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";

const apps = {
  apps: [{ id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail" }],
  legalLinks: [],
};

// Wrapped so that awaiting the helper does not adopt the menu promise itself.
const openAndSettle = async (context: typeof apps) => {
  const { openCloudMobileMenu } = await import("./MobileNavigation");
  const menu = openCloudMobileMenu(context);
  await Bun.sleep(20);
  return { menu };
};

const closeAndSettle = async (menu: Promise<void>) => {
  window.dispatchEvent(new Event("pagehide"));
  await menu;
  await Bun.sleep(20);
};

test("an app without its own menu gives the launchpad the whole sheet", async () => {
  const dom = createDomTestHarness();
  const { menu } = await openAndSettle(apps);
  try {
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector(".k2b-panel-dialog__header")).toBeNull();
    expect(dialog.querySelector(".k2b-dialog__close")).toBeNull();
    expect(dialog.querySelector(".k2b-bottom-sheet__handle")).not.toBeNull();
    expect(dialog.querySelector(".cloud-mobile-apps")).not.toBeNull();
    const heading = dialog.querySelector("h2")!;
    expect(heading.textContent).toBe("All apps");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  } finally {
    await closeAndSettle(menu);
    dom.cleanup();
  }
});

test("an app with its own menu keeps the segmented header", async () => {
  const dom = createDomTestHarness();
  const script = document.createElement("script");
  script.setAttribute("type", "application/json");
  script.setAttribute("data-cloud-workspace-navigation", "");
  script.textContent = JSON.stringify({ label: "Mail", items: [{ id: "inbox", label: "Inbox", href: "/app/mail/inbox" }] });
  document.body.append(script);
  const { menu } = await openAndSettle(apps);
  try {
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector(".k2b-panel-dialog__header h2")?.textContent).toBe("Mail");
    expect(dialog.querySelector(".k2b-dialog__close")).not.toBeNull();
    expect(dialog.querySelector(".cloud-mobile-menu__switch")).not.toBeNull();
    expect(dialog.querySelector(".k2b-navigation__list")).not.toBeNull();
    expect(dialog.querySelector(".cloud-mobile-apps")).toBeNull();
  } finally {
    await closeAndSettle(menu);
    script.remove();
    dom.cleanup();
  }
});
