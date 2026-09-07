import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const spacesCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        comment: {
          title: "Space Kommentar",
          description: "Ein vom Benutzer verfasster Kommentar, der an ein Space-Element angehängt ist.",
        },
        item: {
          title: "Space Artikel",
          description: "Eine Aufgabe oder ein Ereignis innerhalb eines Raums.",
        },
        space: {
          title: "Space",
          description: "Ein berechtigungsbasierter Kollaborationsraum.",
        },
      },
      queries: {
        "task.focus": {
          title: "Offene Aufgaben finden",
          description:
            "Kompakte, seitenweise Aufgabenübersicht über zugängliche Spaces. Nach Zuständigkeit, Frist, Priorität, Blockern oder 30 Tagen Inaktivität filtern.",
        },
        "event.agenda": {
          title: "Kalendervorkommen lesen",
          description:
            "Offene Termine in höchstens 31 Tagen lesen; Wiederholungen werden serverseitig aufgelöst. Auch nach leeren Seiten weiterblättern. Für eine vollständige chronologische Agenda alle Seiten sammeln und nach startsAt sortieren. Cursor nur mit unveränderten Filtern verwenden.",
        },
        "space.browse": {
          title: "Spaces auswählen",
          description:
            "Kompakte, seitenweise Auswahl zugänglicher Spaces mit Berechtigung. Für neue Inhalte minimumPermission write verwenden; space.read nur für Spalten- oder Tag-IDs aufrufen.",
        },
        "task.checklist.list": {
          title: "Aufgabencheckliste lesen",
          description:
            "Checklistenpunkte einer Aufgabe seitenweise mit ID, Text und Erledigt-Status lesen. Weitere Seiten über page.nextCursor abrufen.",
        },
        "calendar-destination.list": {
          title: "Kalenderziele auflisten",
          description:
            "Listen Sie das beschreibbare Ziel Spaces auf, nachdem calendar-invitation.preview kein verknüpftes Ereignis gefunden hat. Übergeben Sie eine zurückgegebene spaceId an calendar-invitation.import.",
          input: { cursor: "Fortsetzung der vorherigen Seite.", limit: "Maximal 100 Ziele pro Seite; page.hasMore beachten." },
        },
        "calendar-invitation.preview": {
          title: "Vorschau der Kalendereinladung",
          description:
            "Starten Sie einen Mail-zu-Spaces-Einladungsfluss, indem Sie den begrenzten iCalendar-Inhalt mit seiner Mail-Mailbox-ID und -Nachrichten-ID analysieren. Zeigt ein sichtbares verknüpftes Ereignis an; Andernfalls verwenden Sie calendar-destination.list vor calendar-invitation.import.",
          input: {
            mailboxId: "Quelle Mail Postfach ID.",
            messageId: "Quelle Mail-Nachricht ID.",
            calendar: "Rohinhalt der iCalendar-Einladung, begrenzt auf 96 KiB.",
          },
        },
        "calendar-invitation.response.prepare": {
          title: "Eine Kalenderantwort vorbereiten",
          description:
            "Bereiten Sie eine standardbasierte Antwort vor, nachdem calendar-invitation.preview ein importiertes beschreibbares Space-Ereignis findet. Erstellen Sie die zurückgegebene Nutzlast mit mail.draft.create und rufen Sie dann calendar-invitation.response.commit auf. Mail IDs sind Korrelationswerte, keine Space-Autorisierung.",
          input: {
            mailboxId: "Quelle Mail Postfach ID.",
            messageId: "Quelle Mail-Nachricht ID.",
            calendar: "Rohinhalt der iCalendar-Einladung, begrenzt auf 96 KiB.",
            attendee: "Mailbox-Identität, die auf die Einladung antwortet.",
            "attendee.name": "Optionaler Anzeigename des Kalenderteilnehmers.",
            "attendee.address": "E-Mail-Adresse des Kalenderteilnehmers.",
            participationStatus: "Einladungsantwort zur Vorbereitung.",
          },
        },
        "comment.list": {
          title: "Kommentare auflisten",
          description:
            "Listen Sie Kommentare zu einem bekannten Element oder wiederkehrenden Vorkommnis auf, nachdem Sie den Space-Zugriff überprüft haben. Holen Sie sich die Artikel-ID von einem spaces.item ref; Verwenden Sie das zurückgegebene spaces.comment refs mit comment.read.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            recurrenceId: "Optionaler Zeitstempel für wiederkehrende Vorkommnisse; für den Artikel oder die ganze Serie weglassen.",
            query: "Optionale Textsuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "comment.read": {
          title: "Kommentar lesen",
          description:
            "Lesen Sie einen von comment.list zurückgegebenen spaces.comment ref, nachdem Sie dessen übergeordnetes Element und Space überprüft haben.",
          input: {
            id: "Kommentar ID, zurückgegeben von Listenkommentaren oder einem spaces.comment ref.",
          },
        },
        "event.list": {
          title: "Ereignisse auflisten",
          description:
            "Durchsuchen Sie Kalenderereignisse in einem bekannten Space. SpaceId, ColumnIds und TagIds von space.read abrufen; Verwenden Sie das zurückgegebene spaces.item refs mit item.read, Kommentaren oder dem Ereignis Actions.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            query: "Optionale Textsuche.",
            status: "Abschlussstatusfilter.",
            priority: "Optionaler Prioritätsfilter.",
            columnIds: "Optionale Spalte IDs, zurückgegeben vom Lesebereich.",
            tagIds: "Optionales Tag IDs, das vom Lesebereich zurückgegeben wird.",
            assigneeIds: "Optionaler Benutzer UUIDs, zurückgegeben von Liste zuweisbarer Space-Mitglieder.",
            assignedTo: "Zuweisungsstatusfilter; me verwendet den Benutzer, der den aktuellen Akteur unterstützt.",
            sort: "Sortierschlüssel für stabile Elemente.",
            sortDesc: "Wenn wahr, absteigend sortieren.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "item.link-candidate.search": {
          title: "Suche nach beschreibbaren Space-Elementen",
          description:
            "Spezialisierte Cross-Space-Suche nach beschreibbaren Aufgaben oder Ereignissen vor item.reference.add. Verwenden Sie item.search für normales Lesen. Übergeben Sie einen zurückgegebenen spaces.item ref als Action-Ziel.",
          input: {
            query: "Optionale Artikeltitel- oder Inhaltssuche.",
            limit: "Maximale Anzahl beschreibbarer Elemente.",
          },
        },
        "item.read": {
          title: "Artikel Space lesen",
          description:
            "Lesen Sie einen spaces.item ref, der von item.search, task.list, event.list oder einer reference-Abfrage zurückgegeben wird. Das Art-Feld unterscheidet Aufgaben von Ereignissen für nachfolgende Actions.",
          input: {
            id: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
          },
        },
        "item.reference.find": {
          title: "Elementen, die mit einer Ressource verknüpft sind suchen",
          description:
            "Finden Sie lesbare Space-Elemente, die mit einer bekannten Cloud-Ressource ref verknüpft sind. Verwenden Sie zurückgegebenes spaces.item refs mit item.read. Verwenden Sie stattdessen item.search für die Titel- oder Workflow-Erkennung.",
          input: {
            ref: "Cloud-Ressource, deren verknüpfte Space-Elemente gefunden werden sollen.",
            "ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "ref.id": "Stabile App-eigene Ressourcenkennung.",
            limit: "Maximale Anzahl verknüpfter Elemente.",
          },
        },
        "item.reference.list": {
          title: "Ressourcenlinks für Artikel auflisten",
          description:
            "Listen Sie die Cloud-Ressource refs auf, die an einen bekannten spaces.item ref angehängt ist. Zurückgegebene refs können direkt an die jeweiligen App-Reader weitergegeben werden; Verwenden Sie item.reference.find für die umgekehrte Suche.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
          },
        },
        "item.search": {
          title: "Space-Artikeln suchen",
          description:
            "Direkter Space-übergreifender Eintrag zum Auffinden lesbarer Aufgaben und Ereignisse nach Text oder Workflow-Facetten. Verwenden Sie zurückgegebenes spaces.item refs mit item.read. Verwenden Sie task.list oder event.list, um einen bekannten Space zu durchsuchen.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            task: {
              title: "Aufgaben",
              description: "Nur Aufgabenelemente anzeigen.",
            },
            todo: {
              title: "Offene Aufgaben",
              description: "Nur offene Aufgaben anzeigen.",
            },
            event: {
              title: "Veranstaltungen",
              description: "Elemente mit einem Zeitbereich anzeigen.",
            },
            urgent: {
              title: "Dringend",
              description: "Nur dringende Artikel anzeigen.",
            },
          },
        },
        "space.assignee.list": {
          title: "Zuweisbare Space-Mitglieder auflisten",
          description:
            "Listen Sie Personen, die für die Aufgaben- oder Ereigniszuweisung in Frage kommen, in einem beschreibbaren Space auf. Rufen Sie die SpaceId von space.list oder space.search ab und übergeben Sie einen zurückgegebenen Benutzer ID an ein Element Action.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            query: "Optionale Textsuche.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "space.list": {
          title: "Leerzeichen auflisten",
          description:
            "Normaler Eintrag für Space-bezogene Arbeiten. Liste zugänglicher Spaces mit wirksamer Genehmigung; Verwenden Sie das zurückgegebene spaces.space refs oder IDs mit space.read, task.list, event.list und der Elementerstellung Actions.",
          input: {
            query: "Optionale Textsuche.",
            minimumPermission: "Für jeden zurückgegebenen Space ist eine wirksame Mindestgenehmigung erforderlich.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "space.read": {
          title: "Leseraum",
          description:
            "Lesen Sie einen von space.list oder space.search zurückgegebenen spaces.space ref, einschließlich der Spalte und des Tags IDs, die für gefilterte Listen und das Element Actions erforderlich sind.",
          input: {
            id: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
          },
        },
        "space.search": {
          title: "Suchräume",
          description:
            "Suchen Sie einen zugänglichen Space anhand des Namens oder der Beschreibung, wenn sein ID unbekannt ist. Verwenden Sie zurückgegebene spaces.space refs mit space.read oder deren IDs mit task.list, event.list und Artikel Actions.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            space: {
              title: "Spaces",
              description: "Nur Leerzeichen anzeigen.",
            },
          },
        },
        "task.blocker.list": {
          title: "Aufgabenblocker auflisten",
          description:
            "Listen Sie Aufgaben auf, die eine bekannte Aufgabe blockieren. ItemId von task.list, item.search oder item.read abrufen; zurückgegebene spaces.item refs kann mit item.read geöffnet werden.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
          },
        },
        "task.blocks.list": {
          title: "Durch eine Aufgabe blockierte Aufgaben auflisten",
          description:
            "Listen Sie Aufgaben auf, die derzeit von einer bekannten Aufgabe blockiert werden. ItemId von task.list, item.search oder item.read abrufen; Verwenden Sie task.blocker.list für die entgegengesetzte Richtung.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
          },
        },
        "task.list": {
          title: "Aufgaben auflisten",
          description:
            "Durchsuchen Sie Aufgaben in einem bekannten Space. SpaceId, ColumnIds und TagIds von space.read abrufen; Verwenden Sie das zurückgegebene spaces.item refs mit item.read, Abhängigkeitsabfragen, Kommentaren oder der Aufgabe Actions.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            query: "Optionale Textsuche.",
            status: "Abschlussstatusfilter.",
            priority: "Optionaler Prioritätsfilter.",
            columnIds: "Optionale Spalte IDs, zurückgegeben vom Lesebereich.",
            tagIds: "Optionales Tag IDs, das vom Lesebereich zurückgegeben wird.",
            assigneeIds: "Optionaler Benutzer UUIDs, zurückgegeben von Liste zuweisbarer Space-Mitglieder.",
            assignedTo: "Zuweisungsstatusfilter; me verwendet den Benutzer, der den aktuellen Akteur unterstützt.",
            sort: "Sortierschlüssel für stabile Elemente.",
            sortDesc: "Wenn wahr, absteigend sortieren.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
      },
      actions: {
        "task.checklist.create": {
          title: "Checklistenpunkt hinzufügen",
          description: "Einen einfachen Checklistenpunkt an eine beschreibbare Aufgabe anhängen.",
        },
        "task.checklist.update": {
          title: "Checklistenpunkt ändern",
          description: "Nur den übergebenen Text oder Erledigt-Status eines Checklistenpunkts ändern.",
        },
        "task.checklist.delete": {
          title: "Checklistenpunkt löschen",
          description: "Einen einzelnen Checklistenpunkt entfernen; die Aufgabe bleibt erhalten.",
        },
        "calendar-invitation.import": {
          title: "Kalendereinladung importieren",
          description:
            "Erstellen, aktualisieren oder stornieren Sie das passende Ereignis idempotent in einem explizit ausgewählten beschreibbaren Space. Mail-Bezeichner sind undurchsichtige Korrelationswerte und gewähren keinen Space-Zugriff.",
          input: {
            mailboxId: "Quelle Mail Postfach ID.",
            messageId: "Quelle Mail-Nachricht ID.",
            calendar: "Rohinhalt der iCalendar-Einladung, begrenzt auf 96 KiB.",
            spaceId: "Beschreibbares Ziel Space ID.",
            conversation: "Quell-Mail-Konversation, die mit dem importierten Ereignis verknüpft ist.",
            "conversation.ref": "Stabile Cloud-Ressource reference",
            "conversation.ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "conversation.ref.id": "Stabile App-eigene Ressourcenkennung.",
            "conversation.label": "Snapshot des Space-eigenen Display-Labels",
          },
        },
        "calendar-invitation.response.commit": {
          title: "Kalenderantwortentwurf festschreiben",
          description:
            "Zeichnen Sie den korrelierten Mail-Entwurf auf, nachdem mail.draft.create erfolgreich war, und überprüfen Sie den Zugriff auf das verknüpfte Space-Ereignis erneut.",
          input: {
            mailboxId: "Quelle Mail Postfach ID.",
            messageId: "Quelle Mail-Nachricht ID.",
            participationStatus: "Antwort in Spaces gespeichert.",
            draftId: "Mail-Entwurf ID erstellt aus der vorbereiteten Antwort.",
          },
        },
        "comment.create": {
          title: "Kommentar erstellen",
          description:
            "Fügen Sie einen vom Benutzer verfassten Kommentar zu einem Element oder einem wiederkehrenden Vorkommen in einem beschreibbaren Space hinzu.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            recurrenceId: "Optionaler Zeitstempel für wiederkehrende Vorkommnisse.",
            content: "Kommentieren Sie den Inhalt.",
          },
        },
        "comment.delete": {
          title: "Kommentar löschen",
          description: "Löschen Sie den eigenen Kommentar des aktuellen Benutzers innerhalb des bestehenden Zehn-Minuten-Fensters.",
          input: {
            commentId: "Stabiles öffentliches ID des letzten Kommentars des aktuellen Benutzers.",
          },
        },
        "comment.update": {
          title: "Kommentar aktualisieren",
          description:
            "Aktualisieren Sie den eigenen Kommentar des aktuellen Benutzers innerhalb von 10 Minuten in einem beschreibbaren Space.",
          input: {
            commentId: "Stabiles öffentliches ID des Kommentars des aktuellen Benutzers.",
            content: "Ersatzkommentarinhalt.",
          },
        },
        "event.create": {
          title: "Kalenderereignis erstellen",
          description: "Erstellen Sie ein Kalenderereignis mit einem explizit gültigen Zeitbereich in einem beschreibbaren Space.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            columnId: "Zielspalte ID, zurückgegeben vom Lesebereich für den ausgewählten Space.",
            title: "Veranstaltungstitel.",
            description: "Optionale Ereignisbeschreibung.",
            location: "Optionaler Veranstaltungsort.",
            url: "Optionales Ereignis URL.",
            startsAt: "Zeitstempel des Ereignisstarts.",
            endsAt: "Zeitstempel für das Ende des Ereignisses nach „startsAt“.",
            allDay: "Ob die Veranstaltung eine ganztägige Präsentation nutzt.",
            recurrence: "Optionale Wiederholungsserie.",
            "recurrence.rrule": "RFC 5545 Wiederholungsregel ohne die RRULE prefix.",
            "recurrence.dtstart": "Optionaler Zeitstempel des Wiederholungsankers.",
            "recurrence.exdate": "Ausgeschlossene Wiederholungszeitstempel.",
            assigneeIds: "Optionaler zugewiesener Benutzer UUIDs von diesem Space.",
            tagIds: "Optionales Tag IDs von diesem Space.",
            references: "Cloud-Ressourcen, die mit dem neuen Ereignis verknüpft sind.",
            "references[].ref": "Stabile Cloud-Ressource reference",
            "references[].ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "references[].ref.id": "Stabile App-eigene Ressourcenkennung.",
            "references[].label": "Snapshot des Space-eigenen Display-Labels",
          },
        },
        "event.create-once": {
          title: "Kalenderereignis einmal erstellen",
          description: "Erstellen Sie ein Kalenderereignis mit wiederholsicherer Idempotenz für dauerhafte Arbeitsabläufe.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            columnId: "Zielspalte ID, zurückgegeben vom Lesebereich für den ausgewählten Space.",
            title: "Veranstaltungstitel.",
            description: "Optionale Ereignisbeschreibung.",
            location: "Optionaler Veranstaltungsort.",
            url: "Optionales Ereignis URL.",
            startsAt: "Zeitstempel des Ereignisstarts.",
            endsAt: "Zeitstempel für das Ende des Ereignisses nach „startsAt“.",
            allDay: "Ob die Veranstaltung eine ganztägige Präsentation nutzt.",
            recurrence: "Optionale Wiederholungsserie.",
            "recurrence.rrule": "RFC 5545 Wiederholungsregel ohne die RRULE prefix.",
            "recurrence.dtstart": "Optionaler Zeitstempel des Wiederholungsankers.",
            "recurrence.exdate": "Ausgeschlossene Wiederholungszeitstempel.",
            assigneeIds: "Optionaler zugewiesener Benutzer UUIDs von diesem Space.",
            tagIds: "Optionales Tag IDs von diesem Space.",
            references: "Cloud-Ressourcen, die mit dem neuen Ereignis verknüpft sind.",
            "references[].ref": "Stabile Cloud-Ressource reference",
            "references[].ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "references[].ref.id": "Stabile App-eigene Ressourcenkennung.",
            "references[].label": "Snapshot des Space-eigenen Display-Labels",
          },
        },
        "event.invitation.commit": {
          title: "Einladung zur Veranstaltung festlegen",
          description:
            "Notieren Sie, dass eine vorbereitete Veranstaltungseinladung an den entsprechenden Mail-Entwurf angehängt wurde, nachdem der Space-Veranstaltungszugriff erneut überprüft wurde.",
          input: {
            deliveryId: "Vorbereitete Einladungszustellung UUID.",
          },
        },
        "event.invitation.prepare": {
          title: "Eine Einladung zur Veranstaltung vorbereiten",
          description:
            "Bereiten Sie eine idempotente iCalendar-Einladung für ein beschreibbares Space-Ereignis vor. Mail-Bezeichner sind undurchsichtige Korrelationswerte und gewähren keinen Space-Zugriff.",
          input: {
            itemId: "Beschreibbares Ereigniselement ID.",
            mailboxId: "Mail-Postfach, das den Zielentwurf besitzt.",
            draftId: "Vorhandener Mail-Entwurf, der die Einladung erhält.",
            senderIdentityId: "Verifizierte Mail-Absenderidentität, die als Organisator verwendet wird.",
            organizer: "Organizer abgeleitet von der verifizierten Mail-Absenderidentität.",
            "organizer.name": "Optionaler Anzeigename des Kalenderteilnehmers.",
            "organizer.address": "E-Mail-Adresse des Kalenderteilnehmers.",
            attendees: "Sichtbare To- und Cc-Empfänger, abgeleitet vom aktuellen Mail-Entwurf.",
            "attendees[].name": "Optionaler Anzeigename des Kalenderteilnehmers.",
            "attendees[].address": "E-Mail-Adresse des Kalenderteilnehmers.",
          },
        },
        "event.update": {
          title: "Ereignis aktualisieren",
          description: "Aktualisieren Sie ausgewählte Ereignisfelder, ohne den Elementtyp zu konvertieren.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            assigneeIds: "Vollständiger Ersatzsatz der Benutzer UUIDs, zurückgegeben von List zuweisbaren Space-Mitgliedern.",
            tagIds: "Kompletter Ersatzsatz des Tags IDs, zurückgegeben von Read Space.",
            title: "Optionaler Veranstaltungstitel.",
            description: "Optionale Ereignisbeschreibung; null löscht es.",
            location: "Optionaler Veranstaltungsort; null löscht es.",
            url: "Optionales Ereignis URL; null löscht es.",
            startsAt: "Beginn der Ersatzveranstaltung; zusammen mit „endsAt“ bereitstellen.",
            endsAt: "Ende der Ersatzveranstaltung; zusammen mit „startsAt“ bereitstellen.",
            allDay: "Ob die Veranstaltung eine ganztägige Präsentation nutzt.",
            recurrence: "Optionale Wiederholungsserie; null entfernt Wiederholungen.",
          },
        },
        "item.delete": {
          title: "Element Space löschen",
          description: "Löschen Sie eine Aufgabe oder ein Ereignis dauerhaft von einem beschreibbaren Space.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
          },
        },
        "item.reference.add": {
          title: "Verknüpfen Sie eine Cloud-Ressource",
          description: "Verknüpfen Sie eine stabile Cloud-Ressource reference mit einem beschreibbaren Space-Element.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            reference: "Zu verknüpfende Cloud-Ressource.",
            "reference.ref": "Stabile Cloud-Ressource reference",
            "reference.ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "reference.ref.id": "Stabile App-eigene Ressourcenkennung.",
            "reference.label": "Snapshot des Space-eigenen Display-Labels",
          },
        },
        "item.reference.remove": {
          title: "Heben Sie die Verknüpfung einer Cloud-Ressource auf",
          description:
            "Entfernen Sie eine Cloud-Ressource reference von einem beschreibbaren Space-Element, einschließlich frei hängender references.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            ref: "Cloud-Ressource zum Aufheben der Verknüpfung.",
            "ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "ref.id": "Stabile App-eigene Ressourcenkennung.",
          },
        },
        "item.tags.set": {
          title: "Artikel-Tags festlegen",
          description:
            "Ersetzen Sie die Tags für eine beschreibbare Aufgabe oder ein beschreibbares Ereignis, ohne die anderen Felder zu ändern.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            tagIds: "Kompletter Ersatzsatz des Tags IDs, zurückgegeben von Read Space.",
          },
        },
        "task.blocker.add": {
          title: "Aufgabenblocker hinzufügen",
          description: "Markieren Sie eine Aufgabe im selben Space als Blocker einer anderen Aufgabe.",
          input: {
            itemId: "Beschreibbare Aufgabe ID.",
            blockerItemId: "Same-Space-Aufgabe, die itemId blockiert.",
          },
        },
        "task.blocker.remove": {
          title: "Den Aufgabenblocker entfernen",
          description: "Entfernen Sie eine Blockierungsbeziehung zwischen zwei Aufgaben.",
          input: {
            itemId: "Beschreibbare Aufgabe ID.",
            blockerItemId: "Same-Space-Aufgabe, die itemId blockiert.",
          },
        },
        "task.create": {
          title: "Aufgabe erstellen",
          description: "Erstellen Sie eine Aufgabe in einer explizit ausgewählten beschreibbaren Space und Spalte.",
          input: {
            spaceId: "Space ID zurückgegeben von Space Suche/Liste/Lesen oder einem spaces.space ref.",
            columnId: "Zielspalte ID, zurückgegeben vom Lesebereich für den ausgewählten Space.",
            title: "Aufgabentitel.",
            description: "Optionale Aufgabenbeschreibung.",
            deadline: "Optionaler Aufgabentermin.",
            estimatedDurationMinutes: "Optionaler Kostenvoranschlag in Minuten.",
            priority: "Optionale Aufgabenpriorität.",
            assigneeIds: "Optionaler zugewiesener Benutzer UUIDs von diesem Space.",
            tagIds: "Optionales Tag IDs von diesem Space.",
            references: "Cloud Ressourcen, die mit der neuen Aufgabe verknüpft sind.",
            "references[].ref": "Stabile Cloud-Ressource reference",
            "references[].ref.type": "Namespace-Ressourcentyp, der von der besitzenden App deklariert wird.",
            "references[].ref.id": "Stabile App-eigene Ressourcenkennung.",
            "references[].label": "Snapshot des Space-eigenen Display-Labels",
          },
        },
        "task.set-completed": {
          title: "Den Abschluss der Aufgabe festlegen",
          description:
            "Schließen Sie eine entsperrte Aufgabe ab oder öffnen Sie eine Aufgabe erneut, indem Sie die Workflow-Spalten Space verwenden.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            completed: "True schließt die Aufgabe ab; false öffnet es erneut.",
          },
        },
        "task.update": {
          title: "Aufgabe aktualisieren",
          description: "Aktualisieren Sie ausgewählte Felder einer vorhandenen Aufgabe, ohne deren Elementtyp zu konvertieren.",
          input: {
            itemId: "Aufgabe oder Ereignis ID, zurückgegeben durch Elementsuche/Liste/Lesen oder ein spaces.item ref.",
            assigneeIds: "Vollständiger Ersatzsatz der Benutzer UUIDs, zurückgegeben von List zuweisbaren Space-Mitgliedern.",
            tagIds: "Kompletter Ersatzsatz des Tags IDs, zurückgegeben von Read Space.",
            title: "Optionaler Aufgabentitel.",
            description: "Optionale Aufgabenbeschreibung; null löscht es.",
            deadline: "Optionaler Aufgabentermin; null löscht es.",
            estimatedDurationMinutes: "Optionaler Kostenvoranschlag in Minuten; null löscht es.",
            priority: "Optionale Aufgabenpriorität; null löscht es.",
          },
        },
      },
    },
  },
};
