import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

/** What people see for Files capabilities in the Assistant, approvals, search, and the capability catalog. */
export const filesCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  sentences: {
    "entry.trash": {
      approval: "Move {input.path} to the trash",
      done: "Moved {input.path} to the trash",
      rejected: "Did not move {input.path} to the trash",
      notRun: "{input.path} not moved to the trash",
    },
    "folder.create": {
      approval: "Create the folder {input.path}",
      done: "Created the folder {input.path}",
      rejected: "Did not create the folder {input.path}",
      notRun: "Folder {input.path} not created",
    },
    "entry.rename": {
      approval: "Rename {input.path} to {input.name}",
      done: "Renamed {input.path} to {input.name}",
      rejected: "Did not rename {input.path}",
      notRun: "{input.path} not renamed",
    },
    "entry.move": {
      approval: "Move {input.path} to {input.folder}",
      done: "Moved {input.path} to {input.folder}",
      rejected: "Did not move {input.path}",
      notRun: "{input.path} not moved",
    },
  },
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
          sentences: {
            approval: "{input.path} in den Papierkorb verschieben",
            done: "{input.path} in den Papierkorb verschoben",
            rejected: "{input.path} nicht in den Papierkorb verschoben",
            notRun: "{input.path} nicht in den Papierkorb verschoben",
          },
          description: "Eine Datei oder einen Ordner mit deinen aktuellen Rechten in den Papierkorb verschieben.",
        },
        "trash.restore": {
          title: "Aus dem Papierkorb wiederherstellen",
          description: "Einen Eintrag aus dem Papierkorb zurückholen. Bestehende Einträge werden nicht überschrieben.",
        },
        "folder.create": {
          title: "Ordner erstellen",
          sentences: {
            approval: "Ordner {input.path} erstellen",
            done: "Ordner {input.path} erstellt",
            rejected: "Ordner {input.path} nicht erstellt",
            notRun: "Ordner {input.path} nicht erstellt",
          },
          description: "Einen neuen Ordner anlegen. Bestehende Einträge werden nicht überschrieben.",
        },
        "entry.rename": {
          title: "Eintrag umbenennen",
          sentences: {
            approval: "{input.path} in {input.name} umbenennen",
            done: "{input.path} in {input.name} umbenannt",
            rejected: "{input.path} nicht umbenannt",
            notRun: "{input.path} nicht umbenannt",
          },
          description: "Eine Datei oder einen Ordner umbenennen. Bestehende Einträge werden nicht überschrieben.",
        },
        "entry.move": {
          title: "Eintrag verschieben",
          sentences: {
            approval: "{input.path} nach {input.folder} verschieben",
            done: "{input.path} nach {input.folder} verschoben",
            rejected: "{input.path} nicht verschoben",
            notRun: "{input.path} nicht verschoben",
          },
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
