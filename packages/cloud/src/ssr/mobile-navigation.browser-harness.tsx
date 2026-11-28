import { createNavigation } from "@k2b/ui";
import { render } from "solid-js/web";
import { openCloudMobileMenu } from "./MobileNavigation";
import { provideWorkspaceNavigation } from "./workspace-navigation";

const owner = document.getElementById("workspace")!;

const notebook = {
  currentId: "work",
  label: "Work",
  icon: "ti-notebook",
  switchLabel: "Switch notebook",
  options: [{ id: "work", label: "Work", href: "#work" }],
};

// `<html data-places>`: a Grids base among nine, as a v2 `Nav` switcher reaches the menu (`V2WorkspaceNavigation`
// `toSwitcher`): the open one with its sign and colour, the others, and the deeds
const bases: Array<[string, string, string]> = [
  ["Werkstatt", "tool", "#c2410c"],
  ["Lager Nord", "building-warehouse", "#0369a1"],
  ["Kunden", "users", "#7c3aed"],
  ["Personal", "id-badge-2", "#be185d"],
  ["Fuhrpark", "car", "#0f766e"],
  ["Einkauf", "shopping-cart", "#b45309"],
  ["Geräteverleih", "tools", "#4d7c0f"],
  ["Projekte 2026", "briefcase", "#1d4ed8"],
  ["Buchhaltung", "receipt", "#475569"],
];
const places = {
  currentId: "/app/grids/B0",
  label: "Werkstatt",
  icon: "ti ti-tool",
  color: "#c2410c",
  switchLabel: "Base wechseln",
  // `<html data-places data-many>`: 500 bases, so the phone's list is bounded as the sidebar's is
  options: (document.documentElement.dataset.many === undefined
    ? bases
    : Array.from({ length: 500 }, (_, index): [string, string, string] => bases[index] ?? [`Base ${index}`, "database", "#0369a1"])
  ).map(([label, icon, color], index) => ({
    id: `/app/grids/B${index}`,
    label,
    icon: `ti ti-${icon}`,
    color,
    href: `#B${index}`,
  })),
  actions: [
    { id: "switcher:0", label: "Neue Base", icon: "ti ti-plus", href: "#new" },
    { id: "switcher:1", label: "Aus Vorlage", icon: "ti ti-template", href: "#template" },
  ],
};
render(() => {
  const navigation = createNavigation({
    // `<html data-folds>`: a mailbox with its folders, among them a fold without a symbol ("Mehr")
    items: () =>
      document.documentElement.dataset.places !== undefined
        ? [
            { id: "home", label: "Übersicht", icon: "ti ti-layout-grid", href: "#home", active: true },
            { id: "orders", label: "Aufträge", icon: "ti ti-clipboard-list", href: "#orders" },
            { id: "customers", label: "Kunden", icon: "ti ti-users", href: "#customers" },
            { id: "parts", label: "Ersatzteile", icon: "ti ti-package", href: "#parts" },
          ]
        : document.documentElement.dataset.folds === undefined
          ? [{ id: "notes", label: "Notes", href: "#notes", active: true }]
          : [
              {
                id: "box",
                label: "Kontakt",
                icon: "ti ti-mail",
                href: "#box",
                disclosure: false,
                children: [
                  { id: "inbox", label: "Posteingang", icon: "ti ti-inbox", href: "#inbox", active: true },
                  { id: "more", label: "Mehr", children: [{ id: "spam", label: "Spam", icon: "ti ti-alert-octagon", href: "#spam" }] },
                  { id: "suppliers", label: "Lieferanten", icon: "ti ti-folder", href: "#suppliers" },
                ],
              },
            ],
    switcher: () => (document.documentElement.dataset.places === undefined ? notebook : places),
  });
  provideWorkspaceNavigation(navigation, { label: () => "Workspace", owner: () => owner });
  return <button onClick={() => void openCloudMobileMenu({ apps: [], legalLinks: [] })}>Open menu</button>;
}, owner);
