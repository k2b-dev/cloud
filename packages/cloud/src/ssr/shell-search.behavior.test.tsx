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

test.skipIf(isServer)("the search host expands each destination the page carries once into a full row", async () => {
  const dom = createDomTestHarness();
  const script = dom.document.createElement("script");
  script.id = "cloud-shell-data";
  script.type = "application/json";
  script.textContent = JSON.stringify({
    apps: [
      { id: "mail", label: "Mail", href: "/app/mail", iconClass: "ti ti-mail", match: "/app/mail", defaultVisible: true },
      { id: "notes", label: "Notebooks", href: "/app/notes", iconClass: "ti ti-notebook", match: "/app/notes", defaultVisible: true },
    ],
    legalLinks: [],
    theme: "light",
    // Registry order, not the rail's alphabetical order.
    searchLinks: {
      notes: [{ label: "Shared notes", href: "/app/notes/shared", keywords: ["team"] }],
      mail: [{ label: "Drafts", description: "Unsent messages", href: "/app/mail/drafts", icon: "ti ti-file" }],
    },
    searchHelpApps: [],
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
    expect(rows).toEqual([
      {
        appId: "notes",
        appName: "Notebooks",
        appIcon: "ti ti-notebook",
        ref: { type: "cloud.navigation", id: "notes:/app/notes/shared" },
        readable: false,
        title: "Shared notes",
        preview: undefined,
        href: "/app/notes/shared",
        icon: "ti ti-notebook",
        priority: 0,
        keywords: ["team"],
      },
      {
        appId: "mail",
        appName: "Mail",
        appIcon: "ti ti-mail",
        ref: { type: "cloud.navigation", id: "mail:/app/mail/drafts" },
        readable: false,
        title: "Drafts",
        preview: "Unsent messages",
        href: "/app/mail/drafts",
        icon: "ti ti-file",
        priority: 0,
        keywords: undefined,
      },
    ]);
  } finally {
    dispose();
    dom.cleanup();
  }
});
