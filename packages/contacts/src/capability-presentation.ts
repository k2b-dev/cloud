import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const contactsCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        book: {
          title: "Adressbuch",
          description: "Eine berechtigungsbezogene Sammlung von Kontakten.",
        },
        contact: {
          title: "Kontakt",
          description: "Eine Person oder Organisation in einem Adressbuch.",
        },
        note: {
          title: "Kontaktnotiz",
          description: "Eine vom Benutzer erstellte Notiz, die an einen Kontakt angehängt ist.",
        },
        tag: {
          title: "Kontakt-Tag",
          description: "Eine Beschriftung im Buchbereich, die Kontakten zugewiesen ist.",
        },
      },
      queries: {
        "book.list": {
          title: "Adressbücher auflisten",
          description:
            "Normaler Eintrag für buchbezogene Kontakte. Listen Sie lesbare Adressbücher mit wirksamen Berechtigungen auf. Verwenden Sie das zurückgegebene contacts.book refs oder IDs mit contact.list, tag.list oder contact.create.",
          input: {
            query: "Optionale Suche nach Adressbuchnamen oder -beschreibung.",
            minimumPermission: "Für jedes zurückgegebene Adressbuch ist eine wirksame Mindestberechtigung erforderlich.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "book.read": {
          title: "Adressbuch lesen",
          description: "Lesen Sie ein von book.list zurückgegebenes contacts.book ref oder Adressbuch ID.",
          input: {
            id: "Adressbuch ID zurückgegeben von Adressbücher auflisten oder ein contacts.book ref.",
          },
        },
        "contact.list": {
          title: "Kontakte auflisten",
          description:
            "Durchsuchen und filtern Sie Kontakte in einem bekannten Adressbuch. BookId von book.list abrufen; Verwenden Sie das zurückgegebene contacts.contact refs mit contact.read. Verwenden Sie stattdessen contact.search, wenn kein Buch bekannt ist.",
          input: {
            bookId: "Adressbuch ID, zurückgegeben von Adressbüchern auflisten oder einer contacts.book-Ressource ref.",
            query: "Optionaler Text, der mit Kontaktfeldern abgeglichen wird.",
            tagIds:
              "Kontakt-Tag IDs zurückgegeben von Kontakt-Tags für dieses Adressbuch auflisten; Entspricht Kontakten, die mindestens einen haben.",
            sort: "Sortierreihenfolge der Kontakte.",
            email: "Filtern Sie nach Präsenz der E-Mail-Adresse.",
            phone: "Filtern Sie nach Telefonnummernpräsenz.",
            favoritesOnly: "Nur vom aktuellen Benutzer favorisierte Kontakte.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "contact.read": {
          title: "Kontakt lesen",
          description:
            "Lesen Sie einen von contact.search, contact.list, contact.suggest oder contact.resolve zurückgegebenen contacts.contact ref, nachdem Sie das zugehörige Adressbuch überprüft haben.",
          input: {
            id: "Kontakt ID zurückgegeben durch Kontaktsuche, Vorschlag, Lösung, Liste oder einen contacts.contact ref.",
          },
        },
        "contact.resolve": {
          title: "Kontakte per E-Mail lösen",
          description:
            "Spezielle Suche nach bekannten genauen E-Mail-Adressen oder wenden Sie sich an IDs. Gibt kanonisches contacts.contact refs zurück; Verwenden Sie contact.search, wenn der Kontakt nicht bekannt ist, und contact.suggest für Empfängervorschläge.",
          input: {
            emails: "Normalisierte E-Mail-Adressen zur Auflösung in jeden lesbaren passenden Kontakt.",
            contactIds: "Optionaler öffentlicher Kontakt IDs, der die Übereinstimmungen weiter einschränkt.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl exakter Kontaktübereinstimmungen, die zurückgegeben werden sollen.",
          },
        },
        "contact.search": {
          title: "Kontakte suchen",
          description:
            "Normaler Cross-Book-Discovery-Eintrag, wenn kein Adressbuch bekannt ist. Suchen Sie Kontakte nach Name, E-Mail, Telefon oder Buchaspekt und verwenden Sie zurückgegebene contacts.contact refs mit contact.read.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            contact: {
              title: "Kontakte",
              description: "Kontaktkarten anzeigen.",
            },
            phone: {
              title: "Telefon",
              description: "Kontakte anzeigen, die eine Telefonnummer haben.",
            },
            email: {
              title: "E-Mail",
              description: "Kontakte anzeigen, die eine E-Mail-Adresse haben.",
            },
          },
        },
        "contact.suggest": {
          title: "Schlagen Sie Kontakte vor",
          description:
            "Spezialisierte Empfängerauswahl zum Verfassen von E-Mails. Gibt E-Mail-fähige Kontakte und contacts.contact refs zurück; Verwenden Sie contact.search für die allgemeine Erkennung oder contact.resolve, wenn genaue E-Mail-Adressen bereits bekannt sind.",
          input: {
            query: "Der Text wird mit lesbaren Kontaktnamen, Organisationen, E-Mail-Adressen, Telefonnummern und Adressen abgeglichen.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Kontaktvorschläge.",
          },
        },
        "note.list": {
          title: "Kontaktnotizen auflisten",
          description:
            "Listen Sie Notizen für einen bekannten Kontakt auf, die neuesten zuerst. Kontakt-ID von einem contacts.contact ref abrufen; Verwenden Sie das zurückgegebene contacts.note refs mit note.read.",
          input: {
            contactId: "Kontakt ID zurückgegeben durch Kontaktsuche, Vorschlag, Lösung, Liste oder einen contacts.contact ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "note.read": {
          title: "Kontaktnotiz lesen",
          description:
            "Lesen Sie einen von note.list zurückgegebenen contacts.note ref, nachdem Sie den übergeordneten Kontakt und das Adressbuch überprüft haben.",
          input: {
            id: "Kontaktnotiz ID, zurückgegeben von Liste Kontaktnotizen oder contacts.note ref.",
          },
        },
        "tag.list": {
          title: "Kontakt-Tags auflisten",
          description:
            "Listen Sie Tags in einem bekannten Adressbuch auf. BookId von book.list abrufen; Verwenden Sie zurückgegebene contacts.tag refs mit tag.read oder deren IDs mit contact.list und tag.change.",
          input: {
            bookId: "Adressbuch ID zurückgegeben von Adressbücher auflisten oder ein contacts.book ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "tag.read": {
          title: "Kontakt-Tag lesen",
          description:
            "Lesen Sie einen von tag.list zurückgegebenen contacts.tag ref, nachdem Sie das zugehörige Adressbuch überprüft haben.",
          input: {
            id: "Kontakt-Tag ID, zurückgegeben von Kontakt-Tags auflisten oder contacts.tag ref.",
          },
        },
      },
      actions: {
        "contact.create": {
          title: "Kontakt erstellen",
          description: "Erstellen Sie einen Kontakt in einem explizit ausgewählten beschreibbaren Adressbuch.",
          input: {
            bookId: "Öffentliches Adressbuch ID, das Eigentümer des Kontakts sein wird.",
            label: "Optionale explizite Anzeigebezeichnung.",
            firstName: "Vorname einer Person.",
            lastName: "Nachname der Person.",
            companyName: "Name der Organisation.",
            department: "Organisationsabteilung.",
            jobTitle: "Berufsbezeichnung.",
            vatId: "Umsatzsteuer-Identifikationsnummer.",
            birthday: "Geburtstag als JJJJ-MM-TT.",
            salutation: "PrefFehlerhafte Anrede.",
            pronouns: "Preferred-Pronomen.",
            preferredLanguage: "Preferred Sprachcode.",
            parentContactId: "Optionaler öffentlicher Elternkontakt ID im selben Buch.",
            tagIds: "Kompletter Ersatzsatz des öffentlichen Buch-Tags IDs.",
            emails: "Kompletter Ersatzsatz an E-Mail-Adressen.",
            "emails[].label": "Optionales E-Mail-Label.",
            "emails[].email": "E-Mail-Adresse.",
            phones: "Kompletter Ersatz-Telefonnummernsatz.",
            "phones[].label": "Optionales Telefonetikett.",
            "phones[].phone": "Telefonnummer.",
            addresses: "Kompletter Ersatzsatz Postadressen.",
            "addresses[].label": "Optionales Adressetikett.",
            "addresses[].recipientName": "Optionaler Empfängername.",
            "addresses[].companyName": "Optionaler Firmenname.",
            "addresses[].line1": "Adresszeile der Hauptstraße.",
            "addresses[].line2": "Optionale sekundäre Adresszeile.",
            "addresses[].postalCode": "Postleitzahl.",
            "addresses[].city": "Stadt oder Ort.",
            "addresses[].stateRegion": "Optionales Bundesland oder Region.",
            "addresses[].countryCode": "Zweibuchstabiger Ländercode.",
            websites: "Kompletter Ersatzsatz von Websites.",
            "websites[].label": "Optionales Website-Label.",
            "websites[].url": "Website URL.",
            bankAccounts: "Kompletter Ersatz-Bankkontensatz.",
            "bankAccounts[].label": "Optionale Bezeichnung des Bankkontos.",
            "bankAccounts[].accountHolderName": "Name des Kontoinhabers.",
            "bankAccounts[].iban": "IBAN oder lokale Kontokennung.",
            "bankAccounts[].bic": "Optionaler BIC.",
            "bankAccounts[].bankName": "Optionaler Bankname.",
            "bankAccounts[].note": "Optionaler Kontovermerk.",
          },
        },
        "contact.delete": {
          title: "Kontakt löschen",
          description: "Einen Kontakt nach einer optimistischen Versionsprüfung dauerhaft löschen.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID zum Löschen.",
            expectedUpdatedAt: "„updateAt“-Wert, der vom letzten Lesevorgang zurückgegeben wurde; verhindert veraltetes Löschen.",
          },
        },
        "contact.move": {
          title: "Kontakt verschieben",
          description:
            "Verschieben Sie einen Kontakt in ein anderes beschreibbares Buch. Buchbezogene Tags und Hierarchielinks werden entfernt.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID zum Bewegen.",
            targetBookId: "Öffentlich beschreibbares Zieladressbuch ID.",
            expectedUpdatedAt: "„updateAt“-Wert, der vom letzten Lesevorgang zurückgegeben wurde; verhindert veraltete Bewegungen.",
          },
        },
        "contact.update": {
          title: "Kontakt aktualisieren",
          description: "Ausgewählte Kontaktfelder aktualisieren; Die bereitgestellten Sammlungsfelder ersetzen ihre aktuellen Werte.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID zum Aktualisieren.",
            expectedUpdatedAt: "„updateAt“-Wert, der vom letzten Lesevorgang zurückgegeben wurde; verhindert verlorene Updates.",
            label: "Optionale explizite Anzeigebezeichnung.",
            firstName: "Vorname einer Person.",
            lastName: "Nachname der Person.",
            companyName: "Name der Organisation.",
            department: "Organisationsabteilung.",
            jobTitle: "Berufsbezeichnung.",
            vatId: "Umsatzsteuer-Identifikationsnummer.",
            birthday: "Geburtstag als JJJJ-MM-TT.",
            salutation: "PrefFehlerhafte Anrede.",
            pronouns: "Preferred-Pronomen.",
            preferredLanguage: "Preferred Sprachcode.",
            parentContactId: "Optionaler öffentlicher Elternkontakt ID im selben Buch.",
            tagIds: "Kompletter Ersatzsatz des öffentlichen Buch-Tags IDs.",
            emails: "Kompletter Ersatzsatz an E-Mail-Adressen.",
            "emails[].label": "Optionales E-Mail-Label.",
            "emails[].email": "E-Mail-Adresse.",
            phones: "Kompletter Ersatz-Telefonnummernsatz.",
            "phones[].label": "Optionales Telefonetikett.",
            "phones[].phone": "Telefonnummer.",
            addresses: "Kompletter Ersatzsatz Postadressen.",
            "addresses[].label": "Optionales Adressetikett.",
            "addresses[].recipientName": "Optionaler Empfängername.",
            "addresses[].companyName": "Optionaler Firmenname.",
            "addresses[].line1": "Adresszeile der Hauptstraße.",
            "addresses[].line2": "Optionale sekundäre Adresszeile.",
            "addresses[].postalCode": "Postleitzahl.",
            "addresses[].city": "Stadt oder Ort.",
            "addresses[].stateRegion": "Optionales Bundesland oder Region.",
            "addresses[].countryCode": "Zweibuchstabiger Ländercode.",
            websites: "Kompletter Ersatzsatz von Websites.",
            "websites[].label": "Optionales Website-Label.",
            "websites[].url": "Website URL.",
            bankAccounts: "Kompletter Ersatz-Bankkontensatz.",
            "bankAccounts[].label": "Optionale Bezeichnung des Bankkontos.",
            "bankAccounts[].accountHolderName": "Name des Kontoinhabers.",
            "bankAccounts[].iban": "IBAN oder lokale Kontokennung.",
            "bankAccounts[].bic": "Optionaler BIC.",
            "bankAccounts[].bankName": "Optionaler Bankname.",
            "bankAccounts[].note": "Optionaler Kontovermerk.",
          },
        },
        "favorite.set": {
          title: "Kontaktfavoriten festlegen",
          description: "Legen Sie den Favoritenstatus des aktuellen Benutzers für einen lesbaren Kontakt fest oder löschen Sie ihn.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID.",
            favorite: "Gewünschter Lieblingsstatus für den aktuellen Benutzer.",
          },
        },
        "note.create": {
          title: "Kontaktnotiz erstellen",
          description: "Hängen Sie eine vom Benutzer erstellte Notiz genau einmal an einen beschreibbaren Kontakt an.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID, dem die Notiz gehört.",
            content: "Inhalt der Notiz im Klartext.",
          },
        },
        "tag.change": {
          title: "Kontakt-Tags ändern",
          description: "Fügen Sie buchbezogene Tags auf einem beschreibbaren Kontakt atomar hinzu und entfernen Sie sie.",
          input: {
            contactId: "Stabiler öffentlicher Kontakt ID, dessen Tags sich ändern sollten.",
            addTagIds: "Öffentliches Buch-Tag IDs zum Hinzufügen.",
            removeTagIds: "Öffentliches Buch-Tag IDs zum Entfernen.",
          },
        },
      },
    },
  },
};
