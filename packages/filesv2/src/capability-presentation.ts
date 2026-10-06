import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

/** What people see for Files capabilities in the Assistant, approvals, search, and the capability catalog. */
export const filesCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        entry: { title: "Datei oder Ordner", description: "Eine Datei oder ein Ordner in einer zugänglichen Cloud- oder FreeIPA-Ablage." },
      },
      queries: {
        "bases.list": {
          title: "Ablagen auflisten",
          description: "Zugängliche persönliche Ablagen und Gruppenablagen auflisten. Nicht verfügbare Ablagen zeigen ihren Zustand.",
        },
        "entry.list": {
          title: "Ordnerinhalt auflisten",
          description: "Eine Seite der Einträge direkt in einem bekannten Ordner lesen.",
        },
        "entry.search-in-base": {
          title: "In einer Ablage suchen",
          description: "Datei- und Ordnernamen in einer bekannten Ablage oder einem Ordner finden. Dateiinhalte werden nicht durchsucht.",
        },
        "trash.list": {
          title: "Papierkorb auflisten",
          description: "Eine Seite wiederherstellbarer Einträge im Papierkorb auflisten.",
        },
        "content.read": {
          title: "Dateiinhalt lesen",
          description: "Eine Datei vollständig als geschützten Datenstrom öffnen.",
        },
        "content.download": {
          title: "Download-Link abrufen",
          description: "Einen kurzlebigen Download-Link für eine einzelne Datei anfordern. Der Zugriff wird dabei erneut geprüft.",
        },
        "provider.list": {
          title: "Dateien zur Auswahl durchsuchen",
          description:
            "Einen Ordner zum Auswählen oder Speichern von Dateien öffnen: zuerst die zugänglichen Ablagen, darin Ordner und Dateien.",
        },
        "entry.read": {
          title: "Dateieintrag lesen",
          description: "Die aktuellen Angaben zu einer Datei oder einem Ordner nach einer Zugriffsprüfung lesen.",
        },
        "entry.search": {
          title: "Dateien durchsuchen",
          description:
            "Datei- und Ordnernamen in bis zu 10 zugänglichen Ablagen finden. Für vollständige Ergebnisse in Dateien weitersuchen.",
          searchTags: { file: { title: "Dateien", description: "Datei- und Ordnernamen durchsuchen." } },
        },
      },
      actions: {
        "content.create": {
          title: "Dateiinhalt schreiben",
          description:
            "Eine Datei unter einem genauen Pfad hochladen. Standardmäßig wird nur neu angelegt; Ersetzen braucht die aktuelle Version.",
        },
        "provider.save": {
          title: "Neue Datei speichern",
          description: "Eine neue Datei in einem beschreibbaren Ordner anlegen. Bestehende Dateien werden nie ersetzt.",
        },
        "entry.trash": {
          title: "In den Papierkorb verschieben",
          description: "Eine Datei oder einen Ordner mit deinen aktuellen Rechten in den Papierkorb verschieben.",
        },
        "trash.restore": {
          title: "Aus dem Papierkorb wiederherstellen",
          description: "Einen Eintrag aus dem Papierkorb zurückholen. Bestehende Einträge werden nicht überschrieben.",
        },
        "folder.create": {
          title: "Ordner erstellen",
          description: "Einen neuen Ordner anlegen. Bestehende Einträge werden nicht überschrieben.",
        },
        "entry.rename": {
          title: "Eintrag umbenennen",
          description: "Eine Datei oder einen Ordner umbenennen. Bestehende Einträge werden nicht überschrieben.",
        },
        "entry.move": {
          title: "Eintrag verschieben",
          description:
            "Eine Datei oder einen Ordner innerhalb derselben Ablage verschieben. Bestehende Einträge werden nicht überschrieben.",
        },
        "entry.copy": {
          title: "Eintrag kopieren",
          description: "Eine Datei oder einen Ordner kopieren, auch in eine andere Ablage. Bestehende Einträge werden nicht überschrieben.",
        },
      },
    },
  },
};
