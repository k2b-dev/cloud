import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AdminNotebooksScreen, { type AdminNotebookRow } from "./AdminNotebooksScreen";

/** Invented notebooks of an installation: dense, with one that nobody can reach. */
const rows: AdminNotebookRow[] = [
  ["Handbuch Lager", "Abläufe, Stationen und Schichten im Zentrallager", "ti ti-forklift", 6],
  ["Projekt Hallenumbau", "Zeitplan, Kosten und Protokolle des Umbaus von Halle 3", "ti ti-building", 4],
  ["Einkauf 2027", "Lieferanten, Rahmenverträge und Preislisten", "ti ti-shopping-cart", 3],
  ["Onboarding", "Erste Tage, Zugänge und Ansprechpersonen für neue Kolleginnen und Kollegen", "ti ti-school", 12],
  ["Altes Wiki", null, "ti ti-archive", 0],
  ["Qualitätssicherung", "Prüfpläne, Reklamationen und Audits", "ti ti-checklist", 5],
  ["Fuhrpark", "Fahrzeuge, Wartung und Tourenplanung", "ti ti-truck", 2],
  ["Team Vertrieb", "Kundengespräche, Angebote und Messen", "ti ti-users", 7],
].map(([name, description, icon, permissionCount], index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  shortId: `nb000${index}`,
  name: name as string,
  description: description as string | null,
  icon: icon as string,
  permissionCount: permissionCount as number,
}));

const root = document.getElementById("root");
if (root) {
  const params = new URLSearchParams(location.search);
  const locale = params.get("lang") === "en" ? "en" : "de";
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AdminNotebooksScreen
          nav={{
            title: "Administration",
            icon: "settings",
            groups: [
              {
                label: "Apps",
                items: [
                  { label: "Mail", icon: "mail", href: "/admin/mail" },
                  { label: "Notizbücher", icon: "note", href: "/admin/notebooks", current: true },
                  { label: "Dateien", icon: "folder", href: "/admin/files" },
                ],
              },
            ],
          }}
          rows={params.get("empty") === "1" ? [] : rows}
          total={params.get("empty") === "1" ? 0 : 48}
          page={1}
          pages={params.get("empty") === "1" ? 1 : 6}
          search={params.get("search") ?? ""}
          orphaned={params.get("empty") === "1" ? 0 : 1}
          permissions={params.get("empty") === "1" ? 0 : 39}
        />
      </LocaleProvider>
    ),
    root,
  );
}
