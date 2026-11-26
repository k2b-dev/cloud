import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AdminNotebooksScreen, { type AdminNotebookRow } from "./AdminNotebooksScreen";

/** Invented notebooks of an installation: enough to fill a page, with one that nobody can reach. */
const rows: AdminNotebookRow[] = [
  ["Handbuch Lager", "Abläufe, Stationen und Schichten im Zentrallager", "ti ti-forklift", 6],
  ["Projekt Hallenumbau", "Zeitplan, Kosten und Protokolle des Umbaus von Halle 3", "ti ti-building", 4],
  ["Einkauf 2027", "Lieferanten, Rahmenverträge und Preislisten", "ti ti-shopping-cart", 3],
  ["Onboarding", "Erste Tage, Zugänge und Ansprechpersonen für neue Kolleginnen und Kollegen", "ti ti-school", 12],
  ["Altes Wiki", null, "ti ti-archive", 0],
  ["Qualitätssicherung", "Prüfpläne, Reklamationen und Audits", "ti ti-checklist", 5],
  ["Fuhrpark", "Fahrzeuge, Wartung und Tourenplanung", "ti ti-truck", 2],
  ["Team Vertrieb", "Kundengespräche, Angebote und Messen", "ti ti-users", 7],
  ["Buchhaltung", "Monatsabschlüsse, Belege und Fristen", "ti ti-calculator", 4],
  ["Personal", "Urlaubsregeln, Schulungen und Stellen", "ti ti-id-badge", 3],
  ["IT-Betrieb", "Server, Zugänge und Störungen", "ti ti-server", 6],
  ["Marketing", "Kampagnen, Texte und Termine", "ti ti-speakerphone", 5],
  ["Kundendienst", "Häufige Fragen und Antworten für die Hotline", "ti ti-headset", 9],
  ["Arbeitssicherheit", "Unterweisungen, Gefährdungen und Notfallpläne", "ti ti-shield-check", 8],
  ["Lieferantenbewertung", "Kriterien und Ergebnisse je Quartal", "ti ti-star", 2],
  ["Messe 2027", "Stand, Personal und Material", "ti ti-presentation", 4],
  ["Produktion Linie 2", "Rüstzeiten, Störungen und Schichtübergaben", "ti ti-settings-automation", 6],
  ["Reisekosten", "Regeln und Pauschalen", "ti ti-plane", 3],
  ["Betriebsrat", "Protokolle und Vereinbarungen", "ti ti-gavel", 2],
  ["Nachhaltigkeit", "Kennzahlen und Maßnahmen", "ti ti-leaf", 3],
  ["Ideen", "Vorschläge aus dem Team", "ti ti-bulb", 11],
  ["Recht", "Verträge, Fristen und Ansprechpersonen", "ti ti-scale", 2],
  ["Standort Nord", "Räume, Schlüssel und Kontakte", "ti ti-map-pin", 4],
  ["Archiv 2025", "Abgeschlossene Projekte", "ti ti-box", 1],
].map(([name, description, icon, permissionCount], index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  shortId: `nb${String(index).padStart(4, "0")}`,
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
          // `?pages=2`: more notebooks than one page holds
          total={params.get("empty") === "1" ? 0 : params.get("pages") === "2" ? 124 : rows.length}
          page={1}
          pages={params.get("pages") === "2" ? 2 : 1}
          search={params.get("search") ?? ""}
          orphaned={params.get("empty") === "1" ? 0 : 1}
          permissions={params.get("empty") === "1" ? 0 : 117}
        />
      </LocaleProvider>
    ),
    root,
  );
}
