import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

export const coreCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        "ai.chat": {
          title: "AI-Gespräch",
          description: "Eine private AI-Konversation, die dem aktuellen Benutzer gehört.",
        },
        "ai.skill": {
          title: "Assistant Skill",
          description: "Ein berechtigungsverwalteter wiederverwendbarer Assistant-Workflow.",
        },
        "ai.task": {
          title: "Geplante AI-Aufgabe",
          description: "Eine einmalige oder wiederkehrende Aufforderung, die an eine eigene AI-Konversation angehängt ist.",
        },
      },
      queries: {
        "ai.chat.read": {
          title: "Ein AI-Gespräch lesen",
          description:
            "Lesen Sie sichtbaren Text von einem core.ai.chat ref, der von ai.chats.search, ai.tasks.list oder einem Core Action zurückgegeben wird. Verwenden Sie ai.chat.search für die Textsuche im bekannten Chat und ai.chat.resources für referenced Cloud-Ressourcen.",
          input: {
            id: "Lesbares ID des eigenen Chats zum Lesen.",
            cursor: "Numerischer Cursor, der von der vorherigen Nachrichtenseite zurückgegeben wurde.",
            limit: "Maximale Anzahl sichtbarer Nachrichten, die zurückgegeben werden sollen.",
          },
        },
        "ai.chat.resources": {
          title: "Die in einer AI-Konversation verwendeten Ressourcen auflisten",
          description:
            "Listen Sie die Cloud-Ressource refs auf oder suchen Sie sie, die in einem bekannten core.ai.chat beobachtet wurde. Holen Sie sich die Chat-ID von ai.chats.search, ai.chat.read oder einem core.ai.task ref. zurückgegebene refs können direkt an die jeweiligen App-Reader weitergegeben werden.",
          input: {
            chatId: "Lesbare sechsstellige AI-Konversation ID.",
            query: "Optionaler Filter für Titel, Typ oder lesbare Ressource ID.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Ressourcenseite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ressourcen refs.",
          },
        },
        "ai.chat.search": {
          title: "Nachrichten in einer AI-Konversation suchen",
          description:
            "Durchsuchen Sie sichtbaren Text in einem bekannten core.ai.chat ref, einschließlich komprimiertem Verlauf. Holen Sie sich die Chat-ID von ai.chats.search, ai.chat.read oder einem core.ai.task ref. Verwenden Sie ai.chat.read, um ohne Suchbegriff zu suchen.",
          input: {
            chatId: "Lesbare sechsstellige AI-Konversation ID.",
            cursor: "Numerischer Cursor, der von der vorherigen Nachrichtenseite zurückgegeben wurde.",
            limit: "Maximale Anzahl sichtbarer Nachrichten, die zurückgegeben werden sollen.",
            query: "Wörter, die in sichtbaren Nachrichten aus diesem Chat übereinstimmen.",
          },
        },
        "ai.chats.resources": {
          title: "Suchressourcen, die in AI-Konversationen verwendet werden",
          description:
            "Direkter Cross-Chat-Eintrag zum Auffinden von Cloud-Ressourcen, die zuvor in aktiven AI-Konversationen verwendet wurden. Zurückgegebene refs können an die jeweiligen App-Reader weitergegeben werden; Verwenden Sie ai.chat.resources, wenn ein Chat bereits bekannt ist.",
          input: {
            query: "Optionaler Filter für Titel, Typ oder lesbare Ressource ID.",
            limit: "Maximale Anzahl der zurückzugebenden Ressourcen refs.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Ressourcenseite zurückgegeben wurde.",
          },
        },
        "ai.chats.search": {
          title: "AI-Gespräche durchsuchen",
          description:
            "Normaler Eintrag zum Suchen der AI-Konversationen des aktuellen Benutzers nach Text oder nach der genauen Cloud-Ressource refs. Verwenden Sie das zurückgegebene core.ai.chat refs mit ai.chat.read, ai.chat.search, ai.chat.resources, Aufgabenerstellung oder ai.chat.message.",
          input: {
            query: "Wörter, die in Chattiteln, Zusammenfassungen oder sichtbaren Nachrichten übereinstimmen.",
            refs: "Erfordern, dass Chats jede genau strukturierte Cloud-Ressource ref enthalten.",
            "refs[].type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "refs[].id": "Stabile App-eigene Ressourcenkennung.",
            archived: "Durchsuchen Sie archivierte Chats anstelle aktiver Chats.",
            limit: "Maximale Anzahl übereinstimmender Chats, die zurückgegeben werden sollen.",
          },
        },
        "ai.skill.read": {
          title: "Einen Assistant Skill lesen",
          description:
            "Lesen Sie einen core.ai.skill ref, der von der Liste Assistant Skills oder einen Skill Action zurückgegeben wird, einschließlich seiner aktuellen Revision und reference-Metadaten.",
          input: {
            id: "Skill ID zurückgegeben von der Liste Skills oder einem core.ai.skill ref.",
          },
        },
        "ai.skill.reference.read": {
          title: "Eine Assistant Skill reference lesen",
          description:
            "Lesen Sie eine genaue Markdown reference, die von Read Assistant Skill zurückgegeben wird, während Sie den aktuellen Skill-Zugriff erneut überprüfen.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
          },
        },
        "ai.skills.list": {
          title: "Liste Assistant Skills",
          description:
            "Normaler Eintrag für Skill-Arbeit. Listen Sie Skills auf, die der aktuelle Akteur lesen und core.ai.skill refs zum Lesen oder Überprüfen zurückgeben kann. Management Actions.",
          input: {
            query: "Optionale Wörter, die in Skill-Namen und -Beschreibungen übereinstimmen.",
            enabled: "Optionaler persönlicher aktivierter Statusfilter.",
            limit: "Maximale Anzahl lesbarer Skills, die zurückgegeben werden sollen.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Skill-Seite zurückgegeben wurde.",
          },
        },
        "ai.task.read": {
          title: "Eine geplante AI-Aufgabe lesen",
          description:
            "Lesen Sie einen von ai.tasks.list zurückgegebenen core.ai.task ref oder einen Task Action, einschließlich seines übergeordneten core.ai.chat ref und der letzten Ausführungen.",
          input: {
            id: "Geplante Aufgabe ID, zurückgegeben von Liste geplanter AI-Aufgaben oder core.ai.task ref.",
          },
        },
        "ai.tasks.list": {
          title: "Geplante AI-Aufgaben auflisten",
          description:
            "Normaler Eintrag für geplante Aufgaben. Listen Sie die Aufgaben des aktuellen Benutzers auf, optional für einen core.ai.chat ref oder einen Status; Verwenden Sie das zurückgegebene core.ai.task refs mit ai.task.read oder der Aufgabe Actions.",
          input: {
            chatId: "Optionale AI-Konversation ID, zurückgegeben durch Chat-Suche/Lesen oder ein core.ai.chat ref.",
            state: "Optionaler Aufgabenlebenszyklusstatus.",
            limit: "Maximale Anzahl der zurückzugebenden Aufgaben.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Aufgabenseite zurückgegeben wurde.",
          },
        },
      },
      actions: {
        "ai.chat.message": {
          title: "Senden Sie eine Nachricht an eine weitere AI-Konversation",
          description:
            "Stellen Sie eine zuordenbare Nachricht für eine andere AI-Konversation in die Warteschlange, nachdem Sie das genaue Ziel und den Text überprüft haben.",
          input: {
            chatId: "Lesbares ID des eigenen Zielchats.",
            text: "Genaue Nachricht, die an den Zielchat gesendet werden soll.",
          },
        },
        "ai.skill.create": {
          title: "Einen Assistant Skill erstellen",
          description: "Erstellen Sie einen überprüften wiederverwendbaren Skill, der dem aktuellen Akteur gehört.",
          input: {
            name: "Kleingeschriebener Skill-Name mit Wörtern, die durch einzelne Bindestriche getrennt sind.",
            description: "Kurze, klare Beschreibung, was der Skill tut und wann der Assistant ihn laden soll.",
            instructions: "Vollständige Markdown-Anweisungen für den Skill.",
          },
        },
        "ai.skill.delete": {
          title: "Einen Assistant Skill löschen",
          description: "Löschen Sie einen verwalteten Skill, alle references und alle Zugriffsgewährungen nach der Überprüfung dauerhaft.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
          },
        },
        "ai.skill.enabled.set": {
          title: "Persönlichen Assistant Skill-Status festlegen",
          description:
            "Aktivieren oder deaktivieren Sie nach der Überprüfung einen lesbaren Skill nur für den aktuellen Benutzer. Der Cloud-Zugriff bleibt unverändert.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            enabled: "Ob dieser Skill für den aktuellen Benutzer aktiv sein soll.",
          },
        },
        "ai.skill.reference.remove": {
          title: "Einen Assistant Skill reference entfernen",
          description: "Entfernen Sie nach der Überprüfung genau eine Markdown reference aus einem beschreibbaren Skill.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
          },
        },
        "ai.skill.reference.set": {
          title: "Stellen Sie eine Assistant Skill reference ein",
          description:
            "Fügen Sie genau eine Markdown reference zu einem beschreibbaren Skill hinzu oder ersetzen Sie sie. Verwenden Sie Set Assistant Skill references für zwei oder mehr Dateien.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
            content: "Vollständiger Markdown-Inhalt für diesen reference.",
          },
        },
        "ai.skill.references.set": {
          title: "Set Assistant Skill references",
          description:
            "Fügen Sie mehrere Markdown references atomar zu einem beschreibbaren Skill hinzu oder ersetzen Sie sie, nachdem Sie jede vollständige begrenzte Datei überprüft haben.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            references: "Referenzen zum atomaren Validieren und Schreiben in einer Skill-Revision.",
            "references[].path":
              "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
            "references[].content": "Vollständiger Markdown-Inhalt für diesen reference.",
          },
        },
        "ai.skill.update": {
          title: "Einen Assistant Skill aktualisieren",
          description:
            "Aktualisieren Sie ein oder mehrere Hauptfelder eines beschreibbaren Skill, nachdem Sie den genauen geänderten Inhalt überprüft haben.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            name: "Kleingeschriebener Skill-Name mit Wörtern, die durch einzelne Bindestriche getrennt sind.",
            description: "Kurze, klare Beschreibung, was der Skill tut und wann der Assistant ihn laden soll.",
            instructions: "Vollständige Markdown-Anweisungen für den Skill.",
          },
        },
        "ai.task.create": {
          title: "Eine geplante AI-Aufgabe erstellen",
          description:
            "Erstellen Sie eine überprüfte zukünftige Eingabeaufforderung in einer eigenen AI-Konversation. Lösen Sie den relativen Benutzerwortlaut vor dem Aufruf in „localAt“ auf.",
          input: {
            chatId: "Lesbare sechsstellige AI-Konversation ID.",
            prompt: "Genaue Aufforderung zur Übermittlung an diesen Chat, wenn die Aufgabe ausgeführt wird.",
            schedule: "Wann diese Aufgabe ausgeführt werden soll.",
            timezone: "Genaue IANA-Zeitzone aus dem aktuellen Laufzeitkontext.",
          },
        },
        "ai.task.delete": {
          title: "Eine geplante AI-Aufgabe löschen",
          description: "Löschen Sie eine Aufgabe und ihren gesamten Ereignisverlauf nach der Überprüfung.",
          input: {
            taskId: "Lesbare geplante Aufgabe mit sechs Zeichen ID.",
          },
        },
        "ai.task.pause": {
          title: "Eine geplante AI-Aufgabe pausieren",
          description: "Pausieren Sie eine eigene geplante Aufgabe nach der Überprüfung.",
          input: {
            taskId: "Lesbare geplante Aufgabe mit sechs Zeichen ID.",
          },
        },
        "ai.task.resume": {
          title: "Eine geplante AI-Aufgabe fortsetzen",
          description: "Nehmen Sie nach der Überprüfung eine eigene geplante Aufgabe wieder auf.",
          input: {
            taskId: "Lesbare geplante Aufgabe mit sechs Zeichen ID.",
          },
        },
        "ai.task.run": {
          title: "Jetzt eine geplante AI-Aufgabe ausführen",
          description: "Stellen Sie ein manuelles Ereignis in die Warteschlange, ohne den zukünftigen Zeitplan zu ändern.",
          input: {
            taskId: "Lesbare geplante Aufgabe mit sechs Zeichen ID.",
          },
        },
        "ai.task.update": {
          title: "Eine geplante AI-Aufgabe aktualisieren",
          description:
            "Aktualisieren Sie die Eingabeaufforderung oder den zukünftigen Zeitplan einer eigenen Aufgabe, nachdem Sie den genauen Ersatz überprüft haben.",
          input: {
            taskId: "Lesbare geplante Aufgabe mit sechs Zeichen ID.",
            prompt: "Beim Ausführen der Aufgabe wird eine Ersatzaufforderung bereitgestellt.",
            schedule: "Einmaliger oder wiederkehrender Ersatzplan.",
            timezone: "Erforderlich mit Zeitplan; Kopieren Sie die aktuelle Laufzeit-IANA-Zeitzone.",
          },
        },
      },
    },
  },
};
