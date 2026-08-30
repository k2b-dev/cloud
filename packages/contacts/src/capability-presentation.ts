import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const contactsCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        book: {
          title: "Adressbuch",
          description: "Eine Kontaktsammlung mit eigenen Zugriffsrechten.",
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
          description: "Eine Kennzeichnung innerhalb eines Adressbuchs, die Kontakten zugewiesen ist.",
        },
      },
      queries: {
        "book.list": {
          title: "Adressbücher auflisten",
          description:
            "Listet alle Adressbücher auf, für die wirksame Leserechte bestehen. Verwenden Sie die zurückgegebenen contacts.book-Refs oder IDs mit contact.list, tag.list oder contact.create.",
          input: {
            query: "Optionale Suche nach Adressbuchnamen oder -beschreibung.",
            minimumPermission: "Für jedes zurückgegebene Adressbuch ist eine wirksame Mindestberechtigung erforderlich.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "book.read": {
          title: "Adressbuch lesen",
          description: "Liest ein von book.list zurückgegebenes contacts.book-Ref oder eine Adressbuch-ID.",
          input: {
            id: "Adressbuch-ID aus book.list oder einem contacts.book-Ref.",
          },
        },
        "contact.list": {
          title: "Kontakte auflisten",
          description:
            "Durchsucht und filtert Kontakte in einem bekannten Adressbuch. Rufen Sie bookId über book.list ab und verwenden Sie die zurückgegebenen contacts.contact-Refs mit contact.read. Ist kein Adressbuch bekannt, verwenden Sie contact.search.",
          input: {
            bookId: "Adressbuch-ID aus book.list oder einem contacts.book-Ref.",
            query: "Optionaler Text, der mit Kontaktfeldern abgeglichen wird.",
            tagIds:
              "Kontakt-Tag-IDs aus tag.list für dieses Adressbuch. Es werden Kontakte mit mindestens einem dieser Tags zurückgegeben.",
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
            id: "Kontakt-ID aus contact.search, contact.suggest, contact.resolve, contact.list oder einem contacts.contact-Ref.",
          },
        },
        "contact.resolve": {
          title: "Kontakte per E-Mail auflösen",
          description:
            "Löst bekannte exakte E-Mail-Adressen oder Kontakt-IDs auf und gibt kanonische contacts.contact-Refs zurück. Verwenden Sie contact.search für unbekannte Kontakte und contact.suggest für Empfängervorschläge.",
          input: {
            emails: "Normalisierte E-Mail-Adressen, die in alle lesbaren passenden Kontakte aufgelöst werden.",
            contactIds: "Optionale öffentliche Kontakt-IDs, welche die Treffer weiter einschränken.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl exakter Kontaktübereinstimmungen, die zurückgegeben werden sollen.",
          },
        },
        "contact.search": {
          title: "Kontakte suchen",
          description:
            "Sucht adressbuchübergreifend nach Name, E-Mail-Adresse, Telefonnummer oder Adressbuchmerkmal, wenn kein Adressbuch bekannt ist. Verwenden Sie die zurückgegebenen contacts.contact-Refs mit contact.read.",
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
          title: "Kontakte vorschlagen",
          description:
            "Schlägt beim Verfassen von E-Mails geeignete Empfänger und contacts.contact-Refs vor. Verwenden Sie contact.search für die allgemeine Suche oder contact.resolve, wenn exakte E-Mail-Adressen bereits bekannt sind.",
          input: {
            query: "Der Text wird mit lesbaren Kontaktnamen, Organisationen, E-Mail-Adressen, Telefonnummern und Adressen abgeglichen.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Kontaktvorschläge.",
          },
        },
        "note.list": {
          title: "Kontaktnotizen auflisten",
          description:
            "Listet die Notizen eines bekannten Kontakts auf, die neuesten zuerst. Rufen Sie die Kontakt-ID aus einem contacts.contact-Ref ab und verwenden Sie die zurückgegebenen contacts.note-Refs mit note.read.",
          input: {
            contactId: "Kontakt-ID aus contact.search, contact.suggest, contact.resolve, contact.list oder einem contacts.contact-Ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "note.read": {
          title: "Kontaktnotiz lesen",
          description:
            "Lesen Sie einen von note.list zurückgegebenen contacts.note ref, nachdem Sie den übergeordneten Kontakt und das Adressbuch überprüft haben.",
          input: {
            id: "Kontaktnotiz-ID aus note.list oder einem contacts.note-Ref.",
          },
        },
        "tag.list": {
          title: "Kontakt-Tags auflisten",
          description:
            "Listet Tags in einem bekannten Adressbuch auf. Rufen Sie bookId über book.list ab und verwenden Sie die zurückgegebenen contacts.tag-Refs mit tag.read oder deren IDs mit contact.list und tag.change.",
          input: {
            bookId: "Adressbuch-ID aus book.list oder einem contacts.book-Ref.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "tag.read": {
          title: "Kontakt-Tag lesen",
          description:
            "Lesen Sie einen von tag.list zurückgegebenen contacts.tag ref, nachdem Sie das zugehörige Adressbuch überprüft haben.",
          input: {
            id: "Kontakt-Tag-ID aus tag.list oder einem contacts.tag-Ref.",
          },
        },
      },
      actions: {
        "contact.create": {
          title: "Kontakt erstellen",
          description: "Erstellt einen Kontakt in einem explizit ausgewählten Adressbuch mit Schreibzugriff.",
          input: {
            bookId: "Öffentliche ID des Adressbuchs, dem der Kontakt zugeordnet wird.",
            label: "Optionale explizite Anzeigebezeichnung.",
            firstName: "Vorname einer Person.",
            lastName: "Nachname der Person.",
            companyName: "Name der Organisation.",
            department: "Organisationsabteilung.",
            jobTitle: "Berufsbezeichnung.",
            vatId: "Umsatzsteuer-Identifikationsnummer.",
            birthday: "Geburtstag als JJJJ-MM-TT.",
            salutation: "Bevorzugte Anrede.",
            pronouns: "Bevorzugte Pronomen.",
            preferredLanguage: "Bevorzugter Sprachcode.",
            parentContactId: "Optionale öffentliche ID des übergeordneten Kontakts im selben Adressbuch.",
            tagIds: "Vollständiger neuer Satz öffentlicher Kontakt-Tag-IDs.",
            emails: "Vollständiger neuer Satz von E-Mail-Adressen.",
            "emails[].label": "Optionales E-Mail-Label.",
            "emails[].email": "E-Mail-Adresse.",
            phones: "Vollständiger neuer Satz von Telefonnummern.",
            "phones[].label": "Optionale Bezeichnung der Telefonnummer.",
            "phones[].phone": "Telefonnummer.",
            addresses: "Vollständiger neuer Satz von Postanschriften.",
            "addresses[].label": "Optionale Bezeichnung der Anschrift.",
            "addresses[].recipientName": "Optionaler Empfängername.",
            "addresses[].companyName": "Optionaler Firmenname.",
            "addresses[].line1": "Erste Adresszeile, normalerweise Straße und Hausnummer.",
            "addresses[].line2": "Optionale sekundäre Adresszeile.",
            "addresses[].postalCode": "Postleitzahl.",
            "addresses[].city": "Stadt oder Ort.",
            "addresses[].stateRegion": "Optionales Bundesland oder Region.",
            "addresses[].countryCode": "Zweibuchstabiger Ländercode.",
            websites: "Vollständiger neuer Satz von Websites.",
            "websites[].label": "Optionales Website-Label.",
            "websites[].url": "Website-URL.",
            bankAccounts: "Vollständiger neuer Satz von Bankkonten.",
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
            contactId: "Stabile öffentliche ID des zu löschenden Kontakts.",
            expectedUpdatedAt: "updatedAt-Wert aus dem letzten Lesevorgang; verhindert das Löschen einer veralteten Version.",
          },
        },
        "contact.move": {
          title: "Kontakt verschieben",
          description:
            "Verschieben Sie einen Kontakt in ein anderes beschreibbares Buch. Buchbezogene Tags und Hierarchielinks werden entfernt.",
          input: {
            contactId: "Stabile öffentliche ID des zu verschiebenden Kontakts.",
            targetBookId: "Öffentliche ID des Zieladressbuchs mit Schreibzugriff.",
            expectedUpdatedAt: "updatedAt-Wert aus dem letzten Lesevorgang; verhindert das Verschieben einer veralteten Version.",
          },
        },
        "contact.update": {
          title: "Kontakt aktualisieren",
          description: "Aktualisiert ausgewählte Kontaktfelder. Angegebene Sammlungsfelder ersetzen ihre bisherigen Werte vollständig.",
          input: {
            contactId: "Stabile öffentliche ID des zu aktualisierenden Kontakts.",
            expectedUpdatedAt: "updatedAt-Wert aus dem letzten Lesevorgang; verhindert verlorene Aktualisierungen.",
            label: "Optionale explizite Anzeigebezeichnung.",
            firstName: "Vorname einer Person.",
            lastName: "Nachname der Person.",
            companyName: "Name der Organisation.",
            department: "Organisationsabteilung.",
            jobTitle: "Berufsbezeichnung.",
            vatId: "Umsatzsteuer-Identifikationsnummer.",
            birthday: "Geburtstag als JJJJ-MM-TT.",
            salutation: "Bevorzugte Anrede.",
            pronouns: "Bevorzugte Pronomen.",
            preferredLanguage: "Bevorzugter Sprachcode.",
            parentContactId: "Optionale öffentliche ID des übergeordneten Kontakts im selben Adressbuch.",
            tagIds: "Vollständiger neuer Satz öffentlicher Kontakt-Tag-IDs.",
            emails: "Vollständiger neuer Satz von E-Mail-Adressen.",
            "emails[].label": "Optionales E-Mail-Label.",
            "emails[].email": "E-Mail-Adresse.",
            phones: "Vollständiger neuer Satz von Telefonnummern.",
            "phones[].label": "Optionale Bezeichnung der Telefonnummer.",
            "phones[].phone": "Telefonnummer.",
            addresses: "Vollständiger neuer Satz von Postanschriften.",
            "addresses[].label": "Optionale Bezeichnung der Anschrift.",
            "addresses[].recipientName": "Optionaler Empfängername.",
            "addresses[].companyName": "Optionaler Firmenname.",
            "addresses[].line1": "Erste Adresszeile, normalerweise Straße und Hausnummer.",
            "addresses[].line2": "Optionale sekundäre Adresszeile.",
            "addresses[].postalCode": "Postleitzahl.",
            "addresses[].city": "Stadt oder Ort.",
            "addresses[].stateRegion": "Optionales Bundesland oder Region.",
            "addresses[].countryCode": "Zweibuchstabiger Ländercode.",
            websites: "Vollständiger neuer Satz von Websites.",
            "websites[].label": "Optionales Website-Label.",
            "websites[].url": "Website-URL.",
            bankAccounts: "Vollständiger neuer Satz von Bankkonten.",
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
          description: "Setzt oder entfernt den Favoritenstatus des aktuellen Benutzers für einen lesbaren Kontakt.",
          input: {
            contactId: "Stabile öffentliche Kontakt-ID.",
            favorite: "Gewünschter Favoritenstatus für den aktuellen Benutzer.",
          },
        },
        "note.create": {
          title: "Kontaktnotiz erstellen",
          description: "Hängen Sie eine vom Benutzer erstellte Notiz genau einmal an einen beschreibbaren Kontakt an.",
          input: {
            contactId: "Stabile öffentliche ID des Kontakts, dem die Notiz zugeordnet wird.",
            content: "Inhalt der Notiz im Klartext.",
          },
        },
        "tag.change": {
          title: "Kontakt-Tags ändern",
          description: "Fügen Sie buchbezogene Tags auf einem beschreibbaren Kontakt atomar hinzu und entfernen Sie sie.",
          input: {
            contactId: "Stabile öffentliche ID des Kontakts, dessen Tags geändert werden.",
            addTagIds: "Öffentliche Kontakt-Tag-IDs, die hinzugefügt werden.",
            removeTagIds: "Öffentliche Kontakt-Tag-IDs, die entfernt werden.",
          },
        },
      },
    },
  },
};
