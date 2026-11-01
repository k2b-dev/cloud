import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

import { geoCapabilityPresentation } from "./geo-capability-presentation";

const codePolicyDefinitionInput = {
  revision: "Stand aus code.policy.read; veraltete Entwürfe werden abgelehnt.",
  definition: "Vollständige neue Richtlinie mit Standard- und Gruppenregeln.",
  "definition.preset": "Voreinstellung: off, admin, open oder custom für bearbeitete Regeln.",
  "definition.rules": "Vollständige Standard- und Gruppenregeln; ausgelassene Gruppenregeln erben den Standard.",
  "definition.rules[].groupId": "UUID der Gruppe oder null für den installationsweiten Standard.",
  "definition.rules[].row": "Einstufung des Aufrufs, unabhängig von der Anwendung.",
  "definition.rules[].value": "automatic führt automatisch aus, admin verlangt Admin-Freigabe, never verbietet.",
};

const codeIdInput = { codeId: "Stabile Code-ID aus der Code-Liste oder dem Lesen eines Codes." };
const codeVersionInput = { ...codeIdInput, versionId: "UUID der unveränderlichen Version aus Einreichung oder Versionsliste." };
const codeComparisonInput = {
  comparisonVersionId: "UUID der genauen Vergleichsversion oder null für einen leeren Ausgangsstand.",
};
const codeVersionDecisionInput = {
  versionId: codeVersionInput.versionId,
  sourceHash: "Unveränderter SHA-256-Hash des geprüften Quelltexts aus dem Vergleich.",
  bundleHash: "Unveränderter SHA-256-Hash des geprüften Bundles aus dem Vergleich.",
  manifestHash: "Unveränderter SHA-256-Hash des gespeicherten Prüfmanifests.",
  ...codeComparisonInput,
  comparisonSourceHash: "Quelltext-Hash der Vergleichsversion oder null für einen leeren Ausgangsstand.",
  comparisonBundleHash: "Bundle-Hash der Vergleichsversion oder null für einen leeren Ausgangsstand.",
};
const codeVersionSubmissionInput = {
  sourceFiles: "Vollständige Zuordnung relativer Dateipfade zum genauen Quelltext aus der Prüfanfrage.",
  bundle: "Genaues geprüftes UTF-8-ESM-Bundle; nicht umformatieren.",
  manifest: "Vollständiger unveränderter Prüfbeleg mit ursprünglichem Einstieg und Richtlinien-Einstufungen.",
  "manifest.version": "Formatversion des Prüfmanifests, derzeit 1.",
  "manifest.entry": "Ursprünglicher Einstiegspfad der Prüfanfrage; Bestandteil des Quelltext-Hashes.",
  "manifest.policyRows": "Eindeutige Einstufungen aller deklarierten Aufrufe sowie der KI- und Internetnutzung.",
  "manifest.secrets": "Secret-Bindungen dieser Version.",
  "manifest.secrets[].origin": "Genauer HTTPS-Ursprung der Bindung.",
  "manifest.secrets[].pathPrefix": "Erlaubter Pfadanfang der Bindung.",
  "manifest.secrets[].headers": "Erlaubte Kopfzeilen der Bindung.",
  "manifest.secrets[].name": "Name des gebundenen Secrets.",
  "manifest.secrets[].binding_revision": "Unveränderliche Bindungsrevision.",
  "manifest.entrypoints": "Alle von der Prüfung erkannten ausführbaren Einstiegspunkte.",
  "manifest.entrypoints[].kind": "Zeitgesteuerter oder manuell gestarteter Einstiegspunkt.",
  "manifest.entrypoints[].entrypoint": "Benannter ESM-Export für die Ausführung.",
  "manifest.entrypoints[].cron": "Zeitplan mit fünf Feldern oder null bei manueller Ausführung.",
  "manifest.entrypoints[].file": "Relative Quelldatei mit dieser Deklaration.",
  "manifest.entrypoints[].line": "Quelltextzeile, beginnend bei 1.",
  "manifest.permissions": "Alle erkannten Operationen und Ziele mit ihren Quelltextstellen.",
  "manifest.permissions[].operation": "Vollständige Operations-ID aus dem Capability-Katalog.",
  "manifest.permissions[].target": "Genaues Operationsziel oder null bei einer anwendungsweiten Operation.",
  "manifest.permissions[].target.type": "Vollständiger Ressourcentyp des Ziels.",
  "manifest.permissions[].target.id": "Wörtliche Ziel-ID oder null bei einem dynamischen persönlichen Ziel.",
  "manifest.permissions[].file": "Relative Quelldatei mit dieser Operation.",
  "manifest.permissions[].line": "Quelltextzeile, beginnend bei 1.",
  "manifest.internet": "Vollständige Liste der genauen HTTPS-Ursprünge dieser Version, auch ohne Secrets.",
  "manifest.ai": "Ob erkannte Aufrufe KI nutzen.",
  "manifest.hashes": "Prüfsummen für Quelltext, erzeugtes SDK und genaues Bundle.",
  "manifest.hashes.source": "SHA-256-Hash des Quelltexts aus der Prüfung.",
  "manifest.hashes.sdk": "SHA-256-Hash des erzeugten SDK aus der Prüfung.",
  "manifest.hashes.bundle": "SHA-256-Hash des genauen Bundles aus der Prüfung.",
  baseVersionId: "UUID der zuletzt gespeicherten Version oder null bei der ersten Einreichung.",
};

export const coreCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      events: { "user.created": { title: "Benutzer erstellt", description: "Eine Benutzeridentität wurde erstmals in Cloud angelegt." } },
      types: {
        user: { title: "Benutzer", description: "Eine Benutzeridentität in Cloud." },
        "ai.chat": {
          title: "KI-Chat",
          description: "Ein privater KI-Chat, der dir gehört.",
        },
        "ai.skill": {
          title: "Skill",
          description: "Ein wiederverwendbarer Ablauf für den Assistenten mit eigenen Zugriffsrechten.",
        },
        "ai.task": {
          title: "Assistant-Routine",
          description: "Ein einmaliger oder wiederkehrender Auftrag in einem deiner KI-Chats.",
        },
      },
      queries: {
        "code.secret.list": {
          title: "Code-Secret-Bindungen auflisten",
          description:
            "Bearbeiter sehen Metadaten und unveränderliche Bindungsrevisionen. Werte und verschlüsselte Daten werden nie ausgegeben.",
          input: {
            codeId: "Öffentliche ID des Codes.",
            cursor: "Cursor der vorherigen Seite.",
            limit: "Größe der Seite.",
          },
        },
        "code.version.diff.read": {
          title: "Vollständigen Code-Vergleich lesen",
          description:
            "Liest begrenzte Abschnitte des vollständigen CodeDiff-JSON zweier unveränderlicher Versionen. Vor der Anzeige vollständig zusammensetzen.",
          input: {
            ...codeVersionInput,
            ...codeComparisonInput,
            offset: "UTF-16-Position aus dem vorherigen Abschnitt; bei 0 beginnen.",
            length: "Maximale UTF-16-Zeichen pro Abschnitt; höchstens 65536.",
          },
        },
        "code.version.diff": {
          title: "Code-Version vergleichen",
          description:
            "Liest vollständige Dateizeilen gegen die letzte freigegebene oder eingeschaltete Version mit genauem Entscheidungsstand.",
          input: codeVersionInput,
        },
        "code.version.list": {
          title: "Code-Versionen auflisten",
          description: "Liest Einreichungen und Freigabe-Belege einschließlich der Allein-Admin-Entscheidung.",
          input: {
            ...codeIdInput,
            before: "Versionsnummer aus nextBefore, ausschließlich dieser Version.",
            limit: "Maximale Anzahl von Einträgen auf dieser Seite; höchstens 50.",
          },
        },
        "code.policy.read": {
          title: "Code-Richtlinie lesen",
          description: "Liest Standard und passende Gruppenregeln; Cloud-Admins sehen die vollständige Tabelle.",
        },
        "code.policy.effective": {
          title: "Wirksame Code-Richtlinie",
          description: "Ermittelt aktuelle Regeln je Einstufung für Besitzer oder Autor. Fremde Sichten erfordern Cloud-Administration.",
          input: {
            owner: "Genauer Code-Besitzer; ohne Angabe die aktuelle Person. Fremde Sichten erfordern Cloud-Administration.",
            "owner.kind": "Art des Besitzers: person, resource oder app.",
            "owner.userId": "UUID der besitzenden Person.",
            "owner.ref": "Genaue Cloud-Ressource, der der Code gehört.",
            "owner.ref.type": "Vollständiger Ressourcentyp der besitzenden Anwendung.",
            "owner.ref.id": "Stabile Ressourcen-ID innerhalb der besitzenden Anwendung.",
            "owner.appId": "Registrierte ID der besitzenden Anwendung.",
            authorId: "UUID des Versionsautors für Ressourcen- oder Anwendungs-Code; nur für Cloud-Admins.",
          },
        },
        "code.policy.preview": {
          title: "Code-Richtlinie prüfen",
          description: "Zeigt Anzahl und Seite betroffener aktiver Codes ohne Änderung. Nur für Cloud-Admins.",
          input: {
            ...codePolicyDefinitionInput,
            cursor: "Letzte betroffene Code-ID aus nextCursor der vorherigen Seite.",
            limit: "Maximale Anzahl betroffener Codes auf dieser Seite; höchstens 50.",
          },
        },
        "code.attention": {
          title: "Aufmerksamkeit für Code prüfen",
          description:
            "Listet für einen genauen Besitzer den lesbaren Code, der jemanden braucht: letzter Lauf fehlgeschlagen, Zugriff an einem Ziel entfernt oder eine Version wartet auf Freigabe.",
          input: {
            owner: "Genauer Code-Besitzer, dessen Code die Seite zeigt.",
            "owner.kind": "Art des Besitzers: person, resource oder app.",
            "owner.userId": "UUID der besitzenden Person.",
            "owner.ref": "Genaue Cloud-Ressource, der der Code gehört.",
            "owner.ref.type": "Vollständiger Ressourcentyp der besitzenden Anwendung.",
            "owner.ref.id": "Stabile Ressourcen-ID innerhalb der besitzenden Anwendung.",
            "owner.appId": "Registrierte ID der besitzenden Anwendung.",
          },
        },
        "code.list": {
          title: "Code auflisten",
          description:
            "Listet eigenen und explizit geteilten Code; Cloud-Admins sehen allen. Für Zugriff als Besitzer-Admin den genauen Besitzer angeben. Dem Cursor auch bei leeren Seiten folgen.",
          input: {
            owner: "Nach einem genauen Code-Besitzer filtern.",
            "owner.kind": "Art des Besitzers: person, resource oder app.",
            "owner.userId": "UUID der besitzenden Person.",
            "owner.ref": "Genaue Cloud-Ressource, der der Code gehört.",
            "owner.ref.type": "Vollständiger Ressourcentyp der besitzenden Anwendung.",
            "owner.ref.id": "Stabile Ressourcen-ID innerhalb der besitzenden Anwendung.",
            "owner.appId": "Registrierte ID der besitzenden Anwendung.",
            cursor: "Letzte Code-ID aus nextCursor der vorherigen Seite.",
            limit: "Maximale Anzahl der auf dieser Seite geprüften Code-Kandidaten; höchstens 20.",
          },
        },
        "code.read": {
          title: "Code lesen",
          description: "Liest Besitzer, feste Code-ID und aktuelle Berechtigung.",
          input: { codeId: "Stabile Code-ID aus core.code.list oder core.code.read." },
        },
        "code.version.read": {
          title: "Code-Version lesen",
          description: "Liest unveränderliche Versionen und Quelltext, Bundle oder Manifest in Teilen.",
          input: {
            codeId: "Stabile Code-ID aus core.code.list oder core.code.read.",
            versionId: "UUID der unveränderlichen Version dieses Codes.",
            content: "Zu lesenden Versionstext auswählen; ohne Angabe werden nur Metadaten geliefert.",
            "content.kind": "Art des Versionstexts: source, bundle oder manifest.",
            "content.path": "Relativer Quelltextpfad aus den Versionsmetadaten.",
            offset: "Position in UTF-16-Codeeinheiten: nullbasiert oder nextOffset des vorherigen Abschnitts.",
            length: "Gewünschte Anzahl an UTF-16-Codeeinheiten, höchstens 16.384; ein einzelnes Surrogatpaar kann zwei Einheiten belegen.",
          },
        },
        "code.run.list": {
          title: "Code-Läufe auflisten",
          description: "Listet Lauf-Metadaten ohne Eingaben, Ausgaben oder Inhalte von Capability-Aufrufen.",
          input: {
            codeId: "Stabile Code-ID aus core.code.list oder core.code.read.",
            cursor: "Undurchsichtiger Laufverlauf-Cursor aus der vorherigen Seite.",
            limit: "Maximale Anzahl der Lauf-Metadaten auf dieser Seite; höchstens 50.",
          },
        },
        "code.attention.list": {
          title: "Code auflisten, der dich braucht",
          description:
            "Listet über alle Besitzer Code einer Ressource oder App, die du verwaltest, wenn er dich braucht: pausiert, letzter Lauf fehlgeschlagen, Zugriff an einem Ziel fehlt oder eine Version wartet auf Freigabe. Dem Cursor auch bei leeren Seiten folgen.",
          input: { cursor: "Letzte geprüfte Code-ID aus nextCursor." },
        },
        "code.run.count": {
          title: "Eigene Code-Läufe zählen",
          description: "Zählt Läufe und fehlgeschlagene Läufe deines persönlichen Codes seit einem Zeitpunkt der letzten 7 Tage.",
          input: { since: "Beginn des gezählten Zeitraums, höchstens 7 Tage zurück, etwa der Beginn deines Tages." },
        },
        "code.run.read": {
          title: "Code-Lauf lesen",
          description: "Liest einen Versuch. Bearbeiter sehen Eingaben, Ausgaben und Aufrufe in Reihenfolge, Leser nur Metadaten.",
          input: {
            codeId: "Stabile Code-ID aus core.code.list oder core.code.read.",
            runId: "UUID eines Laufs dieses Codes.",
            cursor: "Letzte Aufrufnummer aus nextCursor oder 0 für den ersten Aufruf.",
            content: "Optional vollständige JSON-Inhalte einer großen Eingabe, Ausgabe, eines Aufrufs oder Ergebnisses auswählen.",
            "content.kind": "Art des JSON-Inhalts: input, output, call oder result.",
            "content.ordinal": "Aufrufnummer aus der Aufrufseite.",
            offset: "Position in UTF-16-Codeeinheiten: nullbasiert oder nextOffset des vorherigen Abschnitts.",
            length: "Gewünschte Anzahl an UTF-16-Codeeinheiten, höchstens 16.384; ein einzelnes Surrogatpaar kann zwei Einheiten belegen.",
          },
        },
        ...geoCapabilityPresentation,
        "ai.task.run.read": {
          title: "Lauf einer Assistant-Routine lesen",
          description:
            "Zeigt Ergebnis, Fehler und den eigenen Laufverlauf einer deiner Routinen. Nutze Routine- und Lauf-IDs aus ai.task.read. Prüfe und ändere bei einer blockierten Routine zuerst die Freigaben mit ai.task.update. Rufe danach ai.task.run auf.",
          input: {
            taskId: "Routine-ID aus ai.task.read.",
            occurrenceId: "ID des konkreten Laufs aus ai.task.read.",
          },
        },
        "entities.search": {
          title: "Empfänger für Zugriffsrechte suchen",
          description:
            "Sucht sichtbare Benutzer, Gruppen und Dienstkonten für Berechtigungen. Öffentliche und angemeldete Benutzer sind explizite Empfänger und keine Suchergebnisse. Persönliche Linux-Gruppen sind ausgenommen; berechtige stattdessen die Person.",
          input: {
            query: "Name oder Kontokennung; leer werden sichtbare Empfänger aufgelistet.",
            types: "Gewünschte Empfängertypen; ohne Angabe werden alle sichtbaren Typen berücksichtigt.",
            cursor: "Cursor aus der vorherigen Empfängersuche.",
            limit: "Maximale Anzahl pro Seite; bei Folgeseiten unverändert lassen.",
          },
        },
        "ai.skill.access.read": {
          title: "Skill-Zugriffsrechte lesen",
          description:
            "Liest Berechtigungen und deren Revision vor einer Änderung. Erfordert Verwaltungsrechte. Zugriffe auf Skills und Studio-Apps sind unabhängig.",
          input: { skillId: "ID des Skills, dessen Zugriffsrechte gelesen werden." },
        },
        "ai.chat.read": {
          title: "KI-Chat lesen",
          description:
            "Lesen Sie sichtbaren Text von einem core.ai.chat ref, der von ai.chats.search, ai.tasks.list oder einem Core Action zurückgegeben wird. Verwenden Sie ai.chat.search für die Textsuche im bekannten Chat und ai.chat.resources für referenced Cloud-Ressourcen.",
          input: {
            id: "Lesbares ID des eigenen Chats zum Lesen.",
            cursor: "Numerischer Cursor, der von der vorherigen Nachrichtenseite zurückgegeben wurde.",
            limit: "Maximale Anzahl sichtbarer Nachrichten, die zurückgegeben werden sollen.",
          },
        },
        "ai.chat.resources": {
          title: "In einem KI-Chat verwendete Ressourcen auflisten",
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
          title: "Nachrichten in einem KI-Chat durchsuchen",
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
          title: "In KI-Chats verwendete Ressourcen suchen",
          description:
            "Direkter Cross-Chat-Eintrag zum Auffinden von Cloud-Ressourcen, die zuvor in aktiven AI-Konversationen verwendet wurden. Zurückgegebene refs können an die jeweiligen App-Reader weitergegeben werden; Verwenden Sie ai.chat.resources, wenn ein Chat bereits bekannt ist.",
          input: {
            query: "Optionaler Filter für Titel, Typ oder lesbare Ressource ID.",
            limit: "Maximale Anzahl der zurückzugebenden Ressourcen refs.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Ressourcenseite zurückgegeben wurde.",
          },
        },
        "ai.chats.search": {
          title: "KI-Chats durchsuchen",
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
          title: "Skill lesen",
          description:
            "Lesen Sie einen core.ai.skill ref, der von der Liste Assistant Skills oder einen Skill Action zurückgegeben wird, einschließlich seiner aktuellen Revision und reference-Metadaten.",
          input: {
            id: "Skill ID zurückgegeben von der Liste Skills oder einem core.ai.skill ref.",
          },
        },
        "ai.skill.reference.read": {
          title: "Skill-Referenz lesen",
          description:
            "Lesen Sie eine genaue Markdown reference, die von Read Assistant Skill zurückgegeben wird, während Sie den aktuellen Skill-Zugriff erneut überprüfen.",
          input: {
            skillId: "Lesbare sechs Zeichen Skill ID.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
          },
        },
        "ai.skills.list": {
          title: "Skills auflisten",
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
          title: "Assistant-Routine lesen",
          description:
            "Lies eine Routine aus ai.tasks.list oder einer Routine-Aktion über ihren core.ai.task-Verweis, einschließlich des zugehörigen core.ai.chat-Verweises und der letzten Läufe.",
          input: {
            id: "Routine-ID aus „Assistant-Routinen auflisten“ oder einem core.ai.task-Verweis.",
          },
        },
        "ai.tasks.list": {
          title: "Assistant-Routinen auflisten",
          description:
            "Liste deine Routinen auf, optional für einen core.ai.chat-Verweis oder einen Status. Nutze die zurückgegebenen core.ai.task-Verweise mit ai.task.read oder den Routine-Aktionen.",
          input: {
            chatId: "Optionale KI-Chat-ID aus der Chat-Suche, dem Lesen eines Chats oder einem core.ai.chat-Verweis.",
            state: "Optionaler Status der Routine.",
            limit: "Maximale Anzahl der zurückzugebenden Routinen.",
            cursor: "Cursor aus der vorherigen Seite mit Routinen.",
          },
        },
      },
      actions: {
        "code.run": {
          title: "Code ausführen",
          description:
            "Startet den aktiven geprüften Code. Derselbe Anfrageschlüssel liefert den bestehenden Lauf; ein neuer Schlüssel startet erneut.",
          input: {
            codeId: "Code-ID aus code.list oder code.read.",
            entrypoint: "Benannter Einstieg aus dem aktiven geprüften Code-Manifest.",
            input: "JSON-Eingabe für den Einstieg; ohne Angabe null.",
          },
        },
        "code.secret.set": {
          title: "Code-Secret speichern",
          description:
            "Bearbeiter speichern einen privaten Zugangswert, ohne ihn zurückzulesen. Geänderte Ziele gelten erst mit einer neuen Version. Werte nur über CLI oder private Eingabefelder übergeben.",
          input: {
            codeId: "Öffentliche ID des Codes.",
            name: "Name des Secrets.",
            value: "Privater Wert; wird nie zurückgelesen.",
            binding: "Ziel, an das der Wert gebunden ist.",
            "binding.origin": "Genauer HTTPS-Ursprung.",
            "binding.pathPrefix": "Erlaubter Pfadanfang.",
            "binding.headers": "Erlaubte Kopfzeilen.",
            binding_revision: "Erwartete Bindungsrevision.",
          },
        },
        "code.secret.delete": {
          title: "Code-Secret-Wert löschen",
          description:
            "Bearbeiter entfernen den aktuellen Wert für alle Versionen. Unveränderliche Zielbindungen bleiben als Freigabe-Belege erhalten.",
          input: {
            codeId: "Öffentliche ID des Codes.",
            name: "Name des Secrets.",
            binding_revision: "Erwartete Bindungsrevision.",
          },
        },
        "code.version.submit": {
          title: "Code-Version einreichen",
          description:
            "Speichert geprüften Quelltext und Bundle gegen baseVersionId. Fragt nötige Freigaben an; die aktive Version läuft weiter.",
          input: codeVersionSubmissionInput,
        },
        "code.version.approve": {
          title: "Code-Version freigeben",
          description: "Gibt genau diesen Quelltext, dieses Bundle und diesen Vergleich über die Cloud-Admin-Regel der Plattform frei.",
          input: codeVersionDecisionInput,
        },
        "code.version.reject": {
          title: "Code-Version ablehnen",
          description: "Lehnt die genaue Version und ihren Vergleich über dieselbe Plattform-Anfrage ab.",
          input: codeVersionDecisionInput,
        },
        "code.pause": {
          title: "Code pausieren",
          description: "Pausiert weitere Ausführung. Die aktive Version bleibt erhalten; verpasste Ereignisse werden nicht nachgeholt.",
        },
        "code.resume": {
          title: "Code fortsetzen",
          description: "Setzt die aktive Version nach Prüfung der aktuellen Richtlinie und Freigabe-Belege fort.",
        },
        "code.policy.update": {
          title: "Code-Richtlinie ändern",
          description: "Ersetzt die Richtlinie am erwarteten Stand und plant sichtbare Pausen. Veraltete Änderungen werden abgelehnt.",
          input: codePolicyDefinitionInput,
        },
        "ai.skill.access.change": {
          title: "Skill-Zugriffsrechte ändern",
          description:
            "Erteilt, ändert oder entzieht eine Skill-Berechtigung nach erneuter Benutzerbestätigung. Lesen Sie zuerst ai.skill.access.read. Gewährt keinen Zugriff auf Apps, die der Skill referenziert.",
          input: {
            expectedAccessRevision: "Exakte Revision aus ai.skill.access.read; nach einem Konflikt erneut lesen und prüfen.",
            principal: "Neuer Empfänger aus entities.search; entweder principal oder accessId angeben.",
            accessId: "Vorhandene Berechtigungs-ID aus ai.skill.access.read; entweder accessId oder principal angeben.",
            permission: "Neue Berechtigungsstufe; null entzieht die vorhandene Berechtigung.",
          },
        },
        "ai.chat.message": {
          title: "Nachricht an einen anderen KI-Chat senden",
          description:
            "Stellen Sie eine zuordenbare Nachricht für eine andere AI-Konversation in die Warteschlange, nachdem Sie das genaue Ziel und den Text überprüft haben.",
          input: {
            text: "Genaue Nachricht, die an den Zielchat gesendet werden soll.",
          },
        },
        "ai.skill.create": {
          title: "Skill erstellen",
          description: "Erstellen Sie einen überprüften wiederverwendbaren Skill, der dem aktuellen Akteur gehört.",
          input: {
            name: "Kleingeschriebener Skill-Name mit Wörtern, die durch einzelne Bindestriche getrennt sind.",
            description: "Kurze, klare Beschreibung, was der Skill tut und wann der Assistent ihn laden soll.",
            instructions: "Vollständige Markdown-Anweisungen für den Skill.",
          },
        },
        "ai.skill.delete": {
          title: "Skill löschen",
          description: "Löschen Sie einen verwalteten Skill, alle references und alle Zugriffsgewährungen nach der Überprüfung dauerhaft.",
          input: {},
        },
        "ai.skill.enabled.set": {
          title: "Skill für dich aktivieren oder deaktivieren",
          description:
            "Aktivieren oder deaktivieren Sie nach der Überprüfung einen lesbaren Skill nur für den aktuellen Benutzer. Der Cloud-Zugriff bleibt unverändert.",
          input: {
            enabled: "Ob dieser Skill für den aktuellen Benutzer aktiv sein soll.",
          },
        },
        "ai.skill.reference.remove": {
          title: "Skill-Referenz entfernen",
          description: "Entfernen Sie nach der Überprüfung genau eine Markdown reference aus einem beschreibbaren Skill.",
          input: {
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
          },
        },
        "ai.skill.reference.set": {
          title: "Skill-Referenz speichern",
          description:
            "Fügen Sie genau eine Markdown reference zu einem beschreibbaren Skill hinzu oder ersetzen Sie sie. Verwenden Sie Set Assistant Skill references für zwei oder mehr Dateien.",
          input: {
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            path: "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
            content: "Vollständiger Markdown-Inhalt für diesen reference.",
          },
        },
        "ai.skill.references.set": {
          title: "Skill-Referenzen speichern",
          description:
            "Fügen Sie mehrere Markdown references atomar zu einem beschreibbaren Skill hinzu oder ersetzen Sie sie, nachdem Sie jede vollständige begrenzte Datei überprüft haben.",
          input: {
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            references: "Referenzen zum atomaren Validieren und Schreiben in einer Skill-Revision.",
            "references[].path":
              "Exakter Markdown reference-Pfad, der von Read Skill zurückgegeben wurde und mit references/<Name>.md übereinstimmt.",
            "references[].content": "Vollständiger Markdown-Inhalt für diesen reference.",
          },
        },
        "ai.skill.update": {
          title: "Skill ändern",
          description:
            "Aktualisieren Sie ein oder mehrere Hauptfelder eines beschreibbaren Skill, nachdem Sie den genauen geänderten Inhalt überprüft haben.",
          input: {
            expectedRevision: "Genaue Revision, die von Read Skill zurückgegeben wurde.",
            name: "Kleingeschriebener Skill-Name mit Wörtern, die durch einzelne Bindestriche getrennt sind.",
            description: "Kurze, klare Beschreibung, was der Skill tut und wann der Assistent ihn laden soll.",
            instructions: "Vollständige Markdown-Anweisungen für den Skill.",
          },
        },
        "ai.task.create": {
          title: "Assistant-Routine anlegen",
          description:
            "Lege eine autonome Routine in einem deiner KI-Chats an. Ermittle vorher die benötigten Capabilities und lass deren Freigaben prüfen. Code Mode läuft mit bestätigten Capability-, HTTP- und Datenbankfreigaben im Hintergrund. Immer bestätigungspflichtige Capabilities und interaktive Dialoge sind dort nicht verfügbar. Rechne relative Zeitangaben vor dem Aufruf in localAt um.",
          input: {
            grants: "Geprüfte Freigaben für Capabilities, HTTP und RSQL für diese Routine.",
            "grants[].appId": "ID der App, die die Capability bereitstellt.",
            "grants[].capabilityId": "Lokale ID der zuvor gefundenen Capability.",
            "grants[].kind": "Freigabetyp: query/action für Capabilities, http für HTTP-Anfragen oder database für RSQL.",
            "grants[].fixedInput":
              "Festgelegte Eingabefelder zur Einschränkung der Berechtigung; ein leeres Objekt erlaubt beliebige gültige Eingaben.",
            prompt: "Genauer Auftrag für diesen Chat, wenn die Routine läuft.",
            schedule: "Wann diese Routine laufen soll.",
            timezone: "Genaue IANA-Zeitzone aus dem aktuellen Laufzeitkontext.",
            title:
              "Kurzer Name der Routine in der Sprache der Person, etwa „Neue Rechnungen eintragen“. Er steht in Benachrichtigungen und Listen.",
          },
        },
        "ai.task.delete": {
          title: "Assistant-Routine löschen",
          description: "Lösche eine Routine und ihren gesamten Laufverlauf nach der Prüfung.",
          input: {
            taskId: "Lesbare Routine-ID mit sechs Zeichen.",
          },
        },
        "ai.task.pause": {
          title: "Assistant-Routine pausieren",
          description: "Pausiere eine deiner Routinen nach der Prüfung.",
          input: {
            taskId: "Lesbare Routine-ID mit sechs Zeichen.",
          },
        },
        "ai.task.resume": {
          title: "Assistant-Routine fortsetzen",
          description: "Setze eine deiner Routinen nach der Prüfung fort.",
          input: {
            taskId: "Lesbare Routine-ID mit sechs Zeichen.",
          },
        },
        "ai.task.run": {
          title: "Assistant-Routine jetzt ausführen",
          description: "Plane einen manuellen Lauf ein, ohne den zukünftigen Zeitplan zu ändern.",
          input: {
            taskId: "Lesbare Routine-ID mit sechs Zeichen.",
          },
        },
        "ai.task.update": {
          title: "Assistant-Routine ändern",
          description:
            "Ändere Auftrag, zukünftigen Zeitplan oder Capability-Freigaben einer deiner Routinen nach Prüfung der genauen Änderungen. Lies bei fehlenden Rechten zuerst die Routine und den fehlgeschlagenen Lauf. Lass erweiterte Rechte ausdrücklich prüfen und berücksichtige bereits ausgeführte Änderungen vor einem erneuten Start.",
          input: {
            grants: "Vollständige neue Liste der Freigaben; du musst sie prüfen. Lass sie weg, um bestehende Freigaben zu behalten.",
            "grants[].appId": "ID der App, die die Capability bereitstellt.",
            "grants[].capabilityId": "Lokale ID der zuvor gefundenen Capability.",
            "grants[].kind": "Freigabetyp: query/action für Capabilities, http für HTTP-Anfragen oder database für RSQL.",
            "grants[].fixedInput":
              "Festgelegte Eingabefelder zur Einschränkung der Berechtigung; ein leeres Objekt erlaubt beliebige gültige Eingaben.",
            taskId: "Lesbare Routine-ID mit sechs Zeichen.",
            prompt: "Neuer Auftrag für die nächsten Läufe der Routine.",
            schedule: "Neuer einmaliger oder wiederkehrender Zeitplan.",
            title: "Neuer kurzer Name der Routine in der Sprache der Person. Er steht in Benachrichtigungen und Listen.",
            timezone: "Mit Zeitplan erforderlich; übernimm die aktuelle IANA-Zeitzone aus dem Laufzeitkontext.",
          },
        },
      },
    },
  },
};
