import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { NavigationSearchItem } from "../browser/navigation-search";

// The dialog only reports the rows the search host hands it.
let rows: NavigationSearchItem[] | undefined;
mock.module("./GlobalSearchDialog", () => ({
  default: (props: { searchLinks: NavigationSearchItem[] }) => {
    rows = props.searchLinks;
    return null;
  },
}));

test.skipIf(isServer)("the search host expands authorized apps and their static destinations into navigation rows", async () => {
  const dom = createDomTestHarness();
  const script = dom.document.createElement("script");
  script.id = "cloud-shell-data";
  script.type = "application/json";
  script.textContent = JSON.stringify({
    apps: [
      { id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail", match: "/app/mail", defaultVisible: true },
      { id: "tools", label: "Werkzeuge", href: "/tools", iconClass: "ti ti-tools", match: "/tools", defaultVisible: false },
      { id: "notes", label: "Notebooks", href: "/app/notes", iconClass: "ti ti-notebook", match: "/app/notes", defaultVisible: true },
    ],
    legalLinks: [],
    theme: "light",
    // Registry order differs from the authorized shell catalog; Tools needs no static links.
    searchLinks: {
      hidden: [{ label: "Secret", href: "/hidden" }],
      notes: [{ label: "Shared notes", href: "/app/notes/shared", keywords: ["team"] }],
      mail: [{ label: "Drafts", description: "Unsent messages", href: "/app/mail/drafts", icon: "ti ti-file" }],
    },
  });
  dom.document.body.append(script);
  const [{ default: ShellRuntime }, { openGlobalSearch }] = await Promise.all([
    import("./ShellRuntime.island"),
    import("../browser/search"),
  ]);
  const dispose = render(() => createComponent(ShellRuntime, { commands: { searchResources: false } }), dom.root);
  try {
    openGlobalSearch();
    for (let attempt = 0; attempt < 100 && !rows; attempt += 1) await Bun.sleep(5);
    expect(rows).toMatchObject([
      { appId: "mail", title: "Mail", href: "/app/mail", icon: "ti ti-mail", kind: "app", readable: false },
      { appId: "mail", title: "Drafts", href: "/app/mail/drafts", icon: "ti ti-file", preview: "Unsent messages", kind: undefined },
      { appId: "tools", title: "Werkzeuge", href: "/tools", icon: "ti ti-tools", kind: "app", readable: false },
      { appId: "notes", title: "Notebooks", href: "/app/notes", icon: "ti ti-notebook", kind: "app", readable: false },
      {
        appId: "notes",
        appName: "Notebooks",
        appIcon: "ti ti-notebook",
        title: "Shared notes",
        href: "/app/notes/shared",
        icon: "ti ti-notebook",
        priority: 0,
        keywords: ["team"],
        kind: undefined,
      },
    ]);
    expect(rows?.every((row) => !row.readable && row.ref.type === "cloud.navigation" && row.ref.id === `${row.appId}:${row.href}`)).toBe(
      true,
    );
    expect(rows?.some((row) => row.appId === "hidden")).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});
