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
      // the group's "…": its deeds follow the group's entries in the menu
      action: {
        label: "Postfächer verwalten",
        items: [{ label: "Neues Postfach", icon: "mail-plus", onClick: () => void clicked.push("new") }],
      },
      items: [
        {
          label: "Kontakt",
          icon: "mail",
          href: "/app/demo/box",
          onNavigate: (nav) => void opened.push(`box ${nav.href}`),
          // the entry's "…": its row's menu
          menu: [{ label: "Ausblenden", icon: "eye-off", onClick: () => void clicked.push("hide") }, "separator"],
        },
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
        // a fold: closed while none of its entries is the open one
        { label: "Mehr", nested: true, items: [{ label: "Spam", icon: "alert-octagon", href: "/app/demo/spam" }] },
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
            actions: [{ id: "/app/demo/box:menu:0", label: "Ausblenden", icon: "ti ti-eye-off", action: "/app/demo/box:menu:0" }],
            // nested entries stay open, without a toggle, also while none of them is the open one
            disclosure: false,
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
              {
                id: "0:3",
                label: "Mehr",
                defaultExpanded: false,
                children: [{ id: "/app/demo/spam", label: "Spam", icon: "ti ti-alert-octagon", href: "/app/demo/spam" }],
              },
            ],
          },
          { id: "group:0:menu:0", label: "Neues Postfach", icon: "ti ti-mail-plus", action: "group:0:menu:0" },
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

test("in the sheet the mailbox row keeps its whole link, a fold opens and closes, the deeds of a row and a group run", async () => {
  const view = await mount();
  try {
    const rowOf = (name: string) =>
      [...view.host.querySelectorAll(".k2b-navigation__row")].find((row) => row.textContent?.startsWith(name))!;
    // the mailbox and its folders never fold: no toggle beside its link
    expect(rowOf("Kontakt").querySelector(".k2b-navigation__disclosure")).toBeNull();
    // the fold is a toggle, closed while none of its entries is open
    const more = rowOf("Mehr").querySelector<HTMLButtonElement>("button")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    await Bun.sleep(0);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // the group's deed runs from its entry
    const create = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Neues Postfach"),
    )!;
    create.click();
    await Bun.sleep(0);
    expect(view.clicked).toEqual(["new"]);
    // the row's deed runs through the navigation's activation, as its menu does
    await view.registered.navigation.activate("/app/demo/box:menu:0");
    expect(view.clicked).toEqual(["new", "hide"]);
    expect(rowOf("Kontakt").querySelector(".k2b-dropdown__trigger, [aria-haspopup='menu']")).not.toBeNull();
  } finally {
    view.cleanup();
  }
});

test("a tree group keeps its loaded places: a place with children folds them behind its own link, open on the way to the open one", async () => {
  const dom = createDomTestHarness();
  const { default: V2WorkspaceNavigation } = await import("./V2WorkspaceNavigation");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const groups: NavGroup[] = [
    {
      label: "Ordner",
      tree: {
        label: "Ordner",
        current: "texte",
        items: [
          {
            key: "projekte",
            label: "Projekte",
            icon: "folder",
            href: "/files/projekte",
            children: [{ key: "texte", label: "Texte", icon: "folder", href: "/files/texte", count: 4 }],
          },
          // children not loaded yet: a plain link, the folder opens as a page
          { key: "archiv", label: "Archiv", icon: "archive", href: "/files/archiv", branch: true },
        ],
      },
    },
  ];
  const page = render(() => <V2WorkspaceNavigation label="Dateien" groups={groups} />, dom.root);
  try {
    expect(readWorkspaceNavigation()?.navigation.items()).toEqual([
      {
        id: "group:0",
        label: "Ordner",
        section: true,
        children: [
          {
            id: "/files/projekte",
            label: "Projekte",
            icon: "ti ti-folder",
            defaultExpanded: true,
            children: [
              { id: "/files/projekte:self", label: "Projekte", icon: "ti ti-folder", href: "/files/projekte" },
              { id: "/files/texte", label: "Texte", icon: "ti ti-folder", badge: 4, active: true, href: "/files/texte" },
            ],
          },
          { id: "/files/archiv", label: "Archiv", icon: "ti ti-archive", href: "/files/archiv" },
        ],
      },
    ]);
  } finally {
    page();
    dom.cleanup();
  }
});
