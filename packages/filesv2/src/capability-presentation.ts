import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

/** What people see for Files capabilities in the Assistant, approvals, search, and the capability catalog. */
export const filesCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  // What a finished Query did, named in the chat's step list; each German translation gives its own `doneTitle`.
  doneTitles: {
    "bases.list": "Listed storage bases",
    "entry.list": "Listed folder entries",
    "entry.search-in-base": "Searched within storage",
    "trash.list": "Listed trash",
    "content.read": "Read file content",
    "content.download": "Got file download link",
    "provider.list": "Browsed files for a file chooser",
    "activity.get": "Read one file history event",
    "activity.list": "Read file history",
    "activity.chain": "Followed a file movement",
    "share.access": "Read public-link access counts",
    "entry.read": "Read file entry",
    "entry.search": "Searched files",
    "storage.read": "Read machine storage",
    "template.read": "Read file template",
  },
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
      events: {
        "entry.created": {
          title: "Datei hochgeladen",
          description: "Ein Upload zum Anlegen einer Datei in einem Ordner wurde abgeschlossen.",
        },
        "entry.replaced": {
          title: "Datei durch Upload ersetzt",
          description: "Ein Upload zum Ersetzen einer bestehenden Datei in einem Ordner wurde abgeschlossen.",
        },
      },
      types: {
        storage: { title: "Maschinenspeicher", description: "Eine verwaltete Maschinenablage." },
        template: { title: "Dateivorlage", description: "Eine verwaltete Dateivorlage." },
        entry: { title: "Datei oder Ordner", description: "Eine Datei oder ein Ordner in einer zugänglichen Cloud- oder FreeIPA-Ablage." },
      },
      queries: {
        "storage.read": {
          title: "Maschinenspeicher lesen",
          doneTitle: "Maschinenspeicher gelesen",
          description: "Eine Maschinenablage nach derselben Administratorprüfung wie im Teilen-Editor lesen.",
        },
        "template.read": {
          title: "Dateivorlage lesen",
          doneTitle: "Dateivorlage gelesen",
          description: "Vorlagenmetadaten nach derselben Verwalten-Prüfung wie im Teilen-Dialog lesen.",
        },
        "activity.get": {
          title: "Verlaufseintrag lesen",
          doneTitle: "Verlaufseintrag gelesen",
          description: "Einen Eintrag mit denselben aktuellen Sichtrechten wie die Verlaufsliste lesen.",
        },
        "activity.list": {
          title: "Dateiverlauf lesen",
          doneTitle: "Dateiverlauf gelesen",
          description:
            "Eine berechtigte Verlaufsseite lesen oder Namen und alte Pfade suchen. Filter beim Blättern beibehalten; Momentaufnahmen gewähren keinen aktuellen Zugriff.",
        },
        "activity.chain": {
          title: "Dateiumzug verfolgen",
          doneTitle: "Dateiumzug verfolgt",
          description:
            "Bis zu 20 sichtbare Umzugsschritte verfolgen. Das aktuelle Ziel wird nur nach erneuter Rechteprüfung angezeigt; ohne feste Identität bleibt es eine Vermutung.",
        },
        "share.access": {
          title: "Linkzugriffe lesen",
          doneTitle: "Linkzugriffe gelesen",
          description:
            "Als Ersteller oder Administrator Aufruf-, Download- und Passwortfehlerzahlen eines öffentlichen Links im UTC-Datumsbereich lesen.",
        },
        "bases.list": {
          title: "Ablagen auflisten",
          doneTitle: "Ablagen aufgelistet",
          description: "Zugängliche persönliche Ablagen und Gruppenablagen auflisten. Nicht verfügbare Ablagen zeigen ihren Zustand.",
        },
        "entry.list": {
          title: "Ordnerinhalt auflisten",
          doneTitle: "Ordnerinhalt aufgelistet",
          description:
            "Eine Seite der Einträge unter einem relativen Pfad lesen. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "entry.search-in-base": {
          title: "In einer Ablage suchen",
          doneTitle: "In einer Ablage gesucht",
          description:
            "Datei- und Ordnernamen unter einem relativen Pfad finden. Als entry-Ziel den Wurzelverweis aus bases.list verwenden. Dateiinhalte werden nicht durchsucht.",
        },
        "trash.list": {
          title: "Papierkorb auflisten",
          doneTitle: "Papierkorb aufgelistet",
          description:
            "Eine Seite wiederherstellbarer Einträge im Papierkorb auflisten. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "content.read": {
          title: "Dateiinhalt lesen",
          doneTitle: "Dateiinhalt gelesen",
          description: "Eine Datei vollständig als geschützten Datenstrom öffnen.",
        },
        "content.download": {
          title: "Download-Link abrufen",
          doneTitle: "Download-Link abgerufen",
          description: "Einen kurzlebigen Download-Link für eine einzelne Datei anfordern. Der Zugriff wird dabei erneut geprüft.",
        },
        "provider.list": {
          title: "Dateien zur Auswahl durchsuchen",
          doneTitle: "Dateien zur Auswahl durchsucht",
          description:
            "Einen Ordner zum Auswählen oder Speichern von Dateien öffnen: zuerst die zugänglichen Ablagen, darin Ordner und Dateien.",
        },
        "entry.readable": {
          title: "Leser für Datei oder Ordner prüfen",
          description: "Prüfen, welche aktuellen Konten diese Ressource lesen dürfen; ohne Inhaltszugriff.",
          input: {
            id: "Öffentliche ID der Ressource.",
            container: "Erwarteter aktueller Ort; nur bei Typen mit Ort.",
            "container.type": "Typ des erwarteten Orts.",
            "container.id": "Öffentliche ID des erwarteten Orts.",
            principals: "Konkrete Konten, deren Leserecht geprüft wird; höchstens 500.",
          },
        },
        "entry.read": {
          title: "Dateieintrag lesen",
          doneTitle: "Dateieintrag gelesen",
          description: "Die aktuellen Angaben zu einer Datei oder einem Ordner nach einer Zugriffsprüfung lesen.",
        },
        "entry.search": {
          title: "Dateien durchsuchen",
          doneTitle: "Dateien durchsucht",
          description:
            "Datei- und Ordnernamen in bis zu 10 zugänglichen Ablagen finden. Für vollständige Ergebnisse in Dateien weitersuchen.",
          searchTags: { file: { title: "Dateien", description: "Datei- und Ordnernamen durchsuchen." } },
        },
      },
      actions: {
        "file.save.v1": {
          title: "Datei in Dateien speichern",
          description:
            "Eine FileRef in einem beschreibbaren Ordner speichern. Ein belegter Name führt zunächst zu einem Konflikt; Ersetzen benötigt die aktuelle Version und eine ausdrückliche Freigabe.",
        },
        "content.create": {
          title: "Dateiinhalt schreiben",
          description:
            "Eine Datei unter einem relativen Pfad hochladen. Als entry-Ziel den Wurzelverweis aus bases.list verwenden. Standardmäßig wird nur neu angelegt; Ersetzen braucht die aktuelle Version.",
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
          description:
            "Eine Datei oder einen Ordner mit deinen aktuellen Rechten in den Papierkorb verschieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "trash.restore": {
          title: "Aus dem Papierkorb wiederherstellen",
          description:
            "Einen Eintrag aus dem Papierkorb zurückholen. Bestehende Einträge werden nicht überschrieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "folder.create": {
          title: "Ordner erstellen",
          sentences: {
            approval: "Ordner {input.path} erstellen",
            done: "Ordner {input.path} erstellt",
            rejected: "Ordner {input.path} nicht erstellt",
            notRun: "Ordner {input.path} nicht erstellt",
          },
          description:
            "Einen neuen Ordner anlegen. Bestehende Einträge werden nicht überschrieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "entry.rename": {
          title: "Eintrag umbenennen",
          sentences: {
            approval: "{input.path} in {input.name} umbenennen",
            done: "{input.path} in {input.name} umbenannt",
            rejected: "{input.path} nicht umbenannt",
            notRun: "{input.path} nicht umbenannt",
          },
          description:
            "Eine Datei oder einen Ordner umbenennen. Bestehende Einträge werden nicht überschrieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
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
            "Eine Datei oder einen Ordner innerhalb derselben Ablage verschieben. Bestehende Einträge werden nicht überschrieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
        "entry.copy": {
          title: "Eintrag kopieren",
          description:
            "Eine Datei oder einen Ordner kopieren, auch in eine andere Ablage. Bestehende Einträge werden nicht überschrieben. Als entry-Ziel den Wurzelverweis aus bases.list verwenden.",
        },
      },
    },
  },
};
