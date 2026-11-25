import { expect, test } from "bun:test";
import type { NavGroup, NavItem } from "@k2b/ui/v2";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// A v2 page's sidebar in the shell's phone menu: the entries of its `Nav` as the menu's tree, and a tap that opens an
// entry the way the sidebar does. The menu is the real `Navigation` of @k2b/ui, fed by what the page registered.

const fixture = (opened: string[], clicked: string[]) => {
  const groups: NavGroup[] = [
    {
      label: "Postfächer",
      items: [
        { label: "Kontakt", icon: "mail", href: "/app/demo/box", onNavigate: (nav) => void opened.push(`box ${nav.href}`) },
        // a link relative to the page, as a view or a folder of the open mailbox can be
        {
          label: "Gesendet",
          icon: "send",
          href: "?folder=sent",
          onNavigate: (nav) => void opened.push(`folder ${nav.href}`),
          nested: true,
          current: true,
          count: 3,
        },
        // a link without a way to open in place: the menu loads it as a page
        { label: "Archiv", icon: "archive", href: "/app/demo/archive", nested: true, dot: "ok" },
      ],
    },
    {
      // no name, and its first entry is nested: it has no entry to stand under, so it stands on its own
      items: [{ label: "Planen", icon: "calendar", nested: true, onClick: () => void clicked.push("planen") }],
    },
  ];
  const foot: NavItem[] = [{ label: "Ausgeblendet (2)", icon: "eye-off" }];
  return { groups, foot };
};

const mount = async () => {
  const dom = createDomTestHarness();
  // the page stands below the root, so a link relative to it leads elsewhere than the same link read against "/"
  dom.window.history.replaceState(null, "", "/app/demo/box");
  delegateEvents(["click"], dom.document);
  const { default: V2WorkspaceNavigation } = await import("./V2WorkspaceNavigation");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const { Navigation } = await import("@k2b/ui");
  const opened: string[] = [];
  const clicked: string[] = [];
  const { groups, foot } = fixture(opened, clicked);
  const page = render(() => <V2WorkspaceNavigation label="Kontakt" groups={groups} foot={foot} />, dom.root);
  const registered = readWorkspaceNavigation();
  if (!registered) throw new Error("the page registered no navigation");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const menu = render(() => <Navigation navigation={registered.navigation} label={registered.label} />, host);
  return {
    dom,
    host,
    opened,
    clicked,
    registered,
    cleanup: () => {
      menu();
      page();
      dom.cleanup();
    },
  };
};

test("the menu's tree: named groups are sections, nested entries stand under the entry before, the foot follows", async () => {
  const view = await mount();
  try {
    expect(view.registered.label).toBe("Kontakt");
    expect(view.registered.navigation.items()).toEqual([
      {
        id: "group:0",
        label: "Postfächer",
        section: true,
        children: [
          {
            id: "/app/demo/box",
            label: "Kontakt",
            icon: "ti ti-mail",
            href: "/app/demo/box",
            navigation: "enhanced",
            // nested entries stay open, also while none of them is the open one
            children: [
              {
                id: "?folder=sent",
                label: "Gesendet",
                icon: "ti ti-send",
                badge: 3,
                active: true,
                href: "?folder=sent",
                navigation: "enhanced",
              },
              { id: "/app/demo/archive", label: "Archiv", icon: "ti ti-archive", unread: true, href: "/app/demo/archive" },
            ],
          },
        ],
      },
      { id: "1:0", label: "Planen", icon: "ti ti-calendar", action: "1:0" },
      { id: "foot:0", label: "Ausgeblendet (2)", icon: "ti ti-eye-off", action: "foot:0", disabled: true },
    ]);
    // the page sends the same tree with its first render, for the menu before the island loads
    const snapshot = view.dom.root.querySelector("script[data-cloud-workspace-navigation]")?.textContent ?? "";
    expect(JSON.parse(snapshot).items).toEqual(JSON.parse(JSON.stringify(view.registered.navigation.items())));
  } finally {
    view.cleanup();
  }
});

test("a tap opens an entry in place through its own onNavigate, a relative link too; an entry without a link runs its onClick", async () => {
  const view = await mount();
  try {
    const link = (name: string) =>
      [...view.host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent?.includes(name))!;
    link("Gesendet").click();
    await Bun.sleep(0);
    link("Kontakt").click();
    await Bun.sleep(0);
    expect(view.opened).toEqual(["folder ?folder=sent", "box /app/demo/box"]);
    const planen = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Planen"))!;
    planen.click();
    await Bun.sleep(0);
    expect(view.clicked).toEqual(["planen"]);
  } finally {
    view.cleanup();
  }
});
