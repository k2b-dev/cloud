import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const notebooksCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        note: {
          title: "Hinweis",
          description: "Eine Markdown-Notiz in einem barrierefreien Notizbuch.",
        },
        notebook: {
          title: "Notizbuch",
          description: "Eine berechtigungsbezogene Sammlung von Markdown-Notizen.",
        },
        comment: {
          title: "Notizkommentar",
          description: "Dauerhafter Diskussionskontext zu einer zugänglichen Notiz.",
        },
      },
      queries: {
        "comment.list": {
          title: "Notizkommentare auflisten",
          description: "Dauerhafte Markdown-Kommentare zu einer bekannten Notiz auflisten, neueste zuerst.",
          input: {
            noteId: "Notiz-ID aus Notizsuche, Notizbaum, Lesevorgang oder einem notebooks.note-Verweis.",
            cursor: "Undurchsichtiger Cursor der vorherigen Seite.",
            limit: "Maximale Anzahl zurückzugebender Kommentare.",
          },
        },
        "comment.read": {
          title: "Notizkommentar lesen",
          description: "Einen von comment.list zurückgegebenen notebooks.comment-Verweis lesen und den Zugriff auf die zugehörige Notiz prüfen.",
          input: {
            id: "Kommentar-ID aus comment.list oder einem notebooks.comment-Verweis.",
          },
        },
        "note.links": {
          title: "Notiz-Links und Backlinks auflisten",
          description:
            "Listen Sie eingehende oder ausgehende Links auf, nachdem eine Notiz bekannt ist. NoteId von einem notebooks.note ref abrufen; Unzugängliche Ziele werden weggelassen und zurückgegeben. Hinweis refs kann mit note.read geöffnet werden.",
          input: {
            noteId: "Hinweis ID, zurückgegeben durch Notizensuche/-baum/-lesevorgang oder ein notebooks.note ref.",
            direction: "Verknüpfungsrichtung relativ zur ausgewählten Notiz.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "note.read": {
          title: "Notiz lesen",
          description:
            "Lesen Sie einen von note.search, note.tree, note.links oder tag.notes zurückgegebenen notebooks.note ref als begrenztes Markdown-Fenster mit Hashes, Tags und Zusammenfassungen benannter Blöcke.",
          input: {
            id: "Hinweis ID, zurückgegeben durch Notizensuch-/Baum-/Link-/Tag-Ergebnisse oder ein notebooks.note ref.",
            contentOffset: "Nullbasierter Zeichenoffset in die Markdown-Quelle.",
            contentLimit: "Maximale Anzahl zurückzugebender Markdown-Zeichen.",
          },
        },
        "note.search": {
          title: "Notizen durchsuchen",
          description:
            "Direkter notizbuchübergreifender Eintrag zum Auffinden von Markdown-Notizen nach Titel oder Inhalt. Verwenden Sie zurückgegebenes notebooks.note refs mit note.read. Verwenden Sie note.tree, um ein bekanntes Notizbuch ohne Volltextsuche zu durchsuchen.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            note: {
              title: "Notizen",
              description: "Nur Notizen anzeigen.",
            },
          },
        },
        "note.tree": {
          title: "Listennotizenbaum",
          description:
            "Durchsuchen Sie die Hierarchie eines bekannten Notebooks, ohne Markdown zu laden. Holen Sie sich die Notebook-ID von notebook.list oder notebook.search. Verwenden Sie das zurückgegebene notebooks.note refs mit note.read.",
          input: {
            notebookId: "Notebook ID zurückgegeben durch Notebook-Suche/-Liste/-Lesen oder ein notebooks.notebook ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl an zurückzugebenden Lightweight-Baumeinträgen.",
          },
        },
        "notebook.list": {
          title: "Notizbücher auflisten",
          description:
            "Normaler Eintrag für Arbeiten im Notebook-Bereich. Listen Sie zugängliche Notizbücher mit wirksamer Genehmigung auf. Verwenden Sie das zurückgegebene notebooks.notebook refs oder IDs mit notebook.read, note.tree, tag.list oder note.create.",
          input: {
            query: "Optionale Textsuche.",
            minimumPermission: "Für zurückgegebene Notebooks ist eine wirksame Mindestgenehmigung erforderlich.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "notebook.read": {
          title: "Notizbuch lesen",
          description:
            "Lesen Sie einen von notebook.list oder notebook.search zurückgegebenen notebooks.notebook ref, einschließlich der Homepage-Notiz ID.",
          input: {
            id: "Notebook ID, zurückgegeben durch Notebook-Suche/-Liste oder ein notebooks.notebook ref.",
          },
        },
        "notebook.search": {
          title: "Notizbücher durchsuchen",
          description:
            "Finden Sie zugängliche Notizbücher anhand des Namens oder der Beschreibung, wenn kein Notizbuch bekannt ist. Verwenden Sie zurückgegebene notebooks.notebook refs mit notebook.read oder deren IDs mit note.tree und tag.list.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            notebook: {
              title: "Notizbücher",
              description: "Nur Notizbücher anzeigen.",
            },
          },
        },
        "tag.list": {
          title: "Notizbuch-Tags auflisten",
          description:
            "Listen Sie Tags und Notizanzahlen in einem bekannten Notizbuch auf. Holen Sie sich die Notebook-ID von notebook.list oder notebook.search. Verwenden Sie einen zurückgegebenen Tag-Wert mit tag.notes.",
          input: {
            notebookId: "Notebook ID zurückgegeben durch Notebook-Suche/-Liste/-Lesen oder ein notebooks.notebook ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "tag.notes": {
          title: "Notizen nach Tags auflisten",
          description:
            "Listen Sie Notizen mit einem Tag in einem bekannten Notizbuch auf. Holen Sie sich die Notebook-ID von notebook.list und das Tag von tag.list. Verwenden Sie das zurückgegebene notebooks.note refs mit note.read.",
          input: {
            notebookId: "Notebook ID zurückgegeben durch Notebook-Suche/-Liste/-Lesen oder ein notebooks.notebook ref.",
            tag: "Notebook-Tag ohne führendes Rautezeichen.",
            query: "Optionale Textsuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
      },
      actions: {
        "comment.create": {
          title: "Notiz kommentieren",
          description: "Als aktueller Benutzer Markdown-Diskussionskontext zu einer beschreibbaren Notiz hinzufügen.",
          input: {
            noteId: "Beschreibbare Notiz-ID aus Notizsuche, Notizbaum, Lesevorgang oder einem notebooks.note-Verweis.",
            content: "Markdown-Kommentar mit höchstens 5.000 Zeichen.",
          },
        },
        "note.create": {
          title: "Notiz erstellen",
          description: "Erstellen Sie eine Markdown-Notiz in einem explizit ausgewählten beschreibbaren Notizbuch.",
          input: {
            notebookId: "Beschreibbares Notizbuch ID.",
            parentId: "Optionale Elternnotiz ID im selben Notizbuch.",
            position: "Optionale Geschwisterposition; Standardmäßig wird angehängt.",
            content: "Ursprüngliche Markdown-Quelle; Ein Titel wird vom Notizbuch abgeleitet oder generiert.",
          },
        },
        "note.edit": {
          title: "Notiz bearbeiten",
          description: "Wenden Sie konfliktbewusste strukturelle Markdown-Änderungen über den kollaborativen Notizdienst an.",
          input: {
            noteId: "Stabiler beschreibbarer Notizzettel ID.",
            operations: "Entweder ein kompletter Set-Content-Ersatz oder bis zu 20 geordnete strukturelle Markdown-Bearbeitungen.",
            ifUpdatedAt: "Ablehnen, wenn sich der Zeitstempel der Notiz geändert hat.",
            ifContentHash: "Ablehnen, wenn sich der komplette Markdown-Hash geändert hat.",
            ifBlockHash: "Ablehnen, wenn sich der ausgewählte benannte Block geändert hat.",
          },
        },
        "note.move": {
          title: "Notiz verschieben",
          description: "Verschieben Sie eine Notiz in das Notizbuch und lehnen Sie gleichzeitig ungültige Eltern und Zyklen ab.",
          input: {
            noteId: "Stabiler beschreibbarer Notizzettel ID.",
            parentId: "Neue übergeordnete Notiz ID im selben Notizbuch oder null für eine Stammnote.",
            position: "Neue Geschwisterposition.",
          },
        },
      },
    },
  },
};
