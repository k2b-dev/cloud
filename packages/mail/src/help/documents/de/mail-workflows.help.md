---
id: mail-workflows
title: YAML-Referenz für Mail-Workflows
icon: ti ti-code
description: Referenz für Eingaben, Trigger, Aktionen, Bedingungen, Ausdrücke, Grenzen und Beispiele von Mail-Workflows.
order: 70
---

Mail-Workflow-YAML hat drei Schlüssel auf oberster Ebene: `inputs`, `triggers` und `steps`. Nur `steps` ist erforderlich. Name, Beschreibung, Priorität, Ausführungslimits, gespeicherte Versionen und Aktivierungsstatus des Workflows bearbeitest du außerhalb des YAML.

Der Workflow-Quelltext ist auf 200.000 Zeichen begrenzt.

:::reference
- **Name:** 1–160 Zeichen.
- **Beschreibung:** Optional, höchstens 2.000 Zeichen.
- **Priorität:** Eine ganze Zahl von -1.000 bis 1.000, Standard 100. Nehmen mehrere Mail-Workflows dasselbe Ereignis an, laufen niedrigere Werte zuerst.
:::

## Mit einem Workflow für empfangene Nachrichten beginnen {icon="route"}

Dieser Workflow ergänzt ein übertragbares Anbieter-Schlüsselwort, wenn der Betreff einer empfangenen Nachricht den Text `invoice` enthält:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - if:
      contains:
        - "${{ inputs.message.subject }}"
        - invoice
    then:
      - addKeyword:
          message: inputs.message
          keyword: Finance
      - setConversationStatus:
          conversation: inputs.conversation
          status: waiting
```

Wähle vor dem Speichern **Prüfen**. Die Validierung prüft striktes YAML, das Mail-Vokabular, Wertepfade, zugängliche Katalognamen und unvereinbare Aktionskombinationen.

## Eingaben deklarieren {icon="point"}

Mail unterstützt zwei Eingabetypen:

| Typ | Wert |
| --- | --- |
| `mailMessage` | Eine Nachricht in diesem Postfach |
| `mailConversation` | Eine Unterhaltung in diesem Postfach |

Jeder Eingabename muss mit einem Buchstaben oder Unterstrich beginnen und darf nur Buchstaben, Ziffern und Unterstriche enthalten. `required` hat den Standardwert `false`. Setze `required: true`, wenn jeder Aufrufer oder Trigger die Eingabe bereitstellen muss. Ein Trigger muss jede erforderliche Eingabe in seinem `with`-Block binden. `steps` muss mindestens einen Schritt enthalten. Mail lehnt unbekannte Stammschlüssel und Aktionseigenschaften ab.

Einen Workflow ohne `triggers` kannst du prüfen und als inaktiven Entwurf speichern, aber nicht aktivieren. Mail hat bewusst keine eigene API für manuelle Ausführungen oder Zielabfragen.

Mail akzeptiert höchstens 20 Eingaben, 500 Schritte, 20 verschachtelte Schrittebenen, 500 Bedingungen und 20 verschachtelte Bedingungsebenen. Diese Grenzen gelten nach dem Parsen des vollständigen Workflows einschließlich aller Zweige.

## Automatische Trigger verwenden {icon="route"}

### `messageReceived`

`messageReceived` startet einmal für eine stabile, neu importierte Nachricht. Für E-Mails, die der Anbieter direkt in den Papierkorb oder in Spam zustellt, startet er nicht. Verschiebt oder kopiert ein anderes E-Mail-Programm eine Nachricht in einen anderen Ordner, startet er nicht erneut. Auch für eine Kopie einer Nachricht, die das Postfach schon enthält, startet er nicht. Der Trigger stellt Folgendes bereit:

- `trigger.message`
- `trigger.conversation`
- `trigger.occurredAt`

Binde diese Werte an deklarierte Eingaben:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - succeed:
      message: "{{ inputs.message.subject }} empfangen"
```

### `schedule`

`schedule` startet zukünftige Zeitfenster anhand eines fünfteiligen Cron-Ausdrucks mit höchstens 120 Zeichen. `timezone` akzeptiert eine IANA-Zeitzone mit höchstens 80 Zeichen und hat den Standardwert UTC. Die Laufzeit stellt `trigger.occurredAt` und `trigger.slot` bereit. Das aktuelle Mail-Vokabular hat jedoch keinen allgemeinen Datum-Zeit-Eingabetyp, der einen dieser Werte für spätere Schritte speichern kann.

```yaml
triggers:
  schedule:
    cron: "0 8 * * 1-5"
    timezone: Europe/Berlin
    with: {}
steps:
  - succeed:
      message: Die geplante Postfachprüfung wurde ausgeführt.
```

Trigger-Werte gibt es nur, während Mail `with` bindet. Geplante Mail-Workflows können deshalb derzeit nur Schritte nutzen, die keine empfangene Nachricht oder Unterhaltung brauchen. `automaticReply` kann nicht über einen Zeitplan-Trigger ausgeführt werden.

Lasse `triggers` weg, wenn du wiederverwendbares YAML entwirfst, das inaktiv bleiben soll. Ein leerer Block `triggers: {}` ist ungültig. Für die Aktivierung ist mindestens ein Trigger erforderlich.

## Eingabe- und Kontextwerte lesen {icon="route"}

Nachrichtenpfade:

- `inputs.message.id`, `conversationId`, `subject`, `body`, `bodyText`, `bodyHtml`
- `inputs.message.fromAddress`, `fromDomain`
- `inputs.message.sender.0.role`, `name` oder `email`
- `inputs.message.recipients.0.role`, `name` oder `email`
- `inputs.message.attachments.0.id`, `filename`, `contentType`, `disposition`, `contentId` oder `sizeBytes`
- `inputs.message.hasAttachments`, `folderId`, `flags`, `keywords`, `direction`, `internalDate`, `receivedAt`

Unterhaltungspfade:

- `inputs.conversation.id`, `subject`, `summary`, `summaryRevision`, `assigneeUserIds`
- `inputs.conversation.workStatus`, `latestMessageAt`

Ressourcen-IDs von Mail in einem Workflow sind dieselben stabilen sechsstelligen IDs wie in Mail-URLs und Capabilities. Anbieterreferenzen und Datenbank-UUIDs sind intern und keine Workflow-Felder.

Pfade des Ausführungskontexts:

- `context.mailboxId`
- `context.actor.userId`, `context.actor.serviceAccountId`, `context.actor.groupIds`
- `context.occurredAt`

Arrayindizes müssen normale Dezimalindizes wie `.0` sein, nicht `.00`. Ein fehlender oder nicht unterstützter Pfad ist ein Validierungsfehler.

## Literale, Referenzen und Ausdrücke schreiben {icon="pencil"}

- Ein einfacher Wert wie `Finance` ist wörtlicher Text.
- Ein dynamischer Wert verwendet die vollständige Ausdruckszeichenfolge: `"${{ inputs.message.subject }}"`.
- `${{ now() }}` gibt die Uhr der Ausführung als ISO-Datum-Zeit-Wert zurück.
- Textfelder wie Antwortbetreff, Antworttext und `succeed.message` sind Liquid-Vorlagen: `"Re: {{ inputs.message.subject }}"`.
- Aktionsfelder, die nur Referenzen akzeptieren, verwenden rohe Pfade wie `message: inputs.message` und `conversation: inputs.conversation`.
- `{{ context.occurredAt }}` enthält den Zeitpunkt des Workflow-Ereignisses.
- `setVariable` erstellt einen Wert für spätere Schritte im selben Gültigkeitsbereich.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
steps:
  - setVariable:
      name: senderAddress
      value: "${{ inputs.message.sender.0.email }}"
  - succeed:
      message: "Nachricht von {{ senderAddress }} wurde um {{ context.occurredAt }} verarbeitet"
```

Variablen, die innerhalb eines Zweigs erstellt werden, sind außerhalb dieses Zweigs nicht verfügbar. Du darfst denselben Variablennamen in einem Gültigkeitsbereich nicht zweimal definieren.

## Mail-Aktionen verwenden {icon="route"}

| Aktion | Erforderliche Felder | Auswirkung |
| --- | --- | --- |
| `addKeyword` | `message`, `keyword` | Ergänzt ein übertragbares Anbieter-Schlüsselwort |
| `removeKeyword` | `message`, `keyword` | Entfernt ein übertragbares Anbieter-Schlüsselwort |
| `moveMessage` | `message`, `folder` | Verschiebt die Nachricht in einen zugänglichen Anbieterordner |
| `copyMessage` | `message`, `folder` | Kopiert die Nachricht in einen zugänglichen Anbieterordner |
| `archiveMessage` | `message` | Verschiebt die Nachricht in den Archivordner des Postfachs; bei Gmail ohne zugeordneten Archivordner wie die Aktion Archivieren nach **All Mail** |
| `trashMessage` | `message` | Verschiebt die Nachricht in den Papierkorbordner des Postfachs |
| `junkMessage` | `message` | Verschiebt die Nachricht in den Spamordner des Postfachs |
| `addFlag` / `removeFlag` | `message`, `flag` | Ändert `seen`, `answered`, `flagged` oder `draft` über das Befehlsjournal des Anbieters |
| `assignConversation` | `conversation`, `user` | Ersetzt die zugewiesenen Personen durch eine Person, die zugewiesen werden kann, anhand ihres Namens oder ihrer ID; `null` entfernt alle Zuweisungen |
| `setConversationStatus` | `conversation`, `status` | Setzt `needs_action`, `waiting` oder `done` |
| `setConversationSummary` | `conversation`, `summary` | Ersetzt die bearbeitbare Zusammenfassung der Unterhaltung |
| `ensureConversationReference` | `conversation`; optional `saveAs` | Vergibt die permanente Postfachreferenz oder verwendet sie erneut und speichert optional das Ergebnis |
| `addLocalTag` / `removeLocalTag` | `conversation`, `tag` | Ändert einen postfachlokalen Tag der Unterhaltung |
| `addComment` | `conversation`, `body` | Ergänzt einen internen Kommentar, der der Workflow-Version zugeordnet ist |
| `createDraft` | `sender`, `to`, `subject`, `body`, `saveAs` | Erstellt für einen späteren Schritt einen Workflow-Entwurf mit normaler Zustellung |
| `createReplyDraft` | `message`, `conversation`, `sender`, `body`, `saveAs` | Erstellt in der Quellunterhaltung einen prüfbaren Antwortentwurf |
| `scheduleDraftSend` | `draft`, `scheduledAt` | Plant den Versand eines erstellten Entwurfs mit normaler Zustellung über den dauerhaften Postausgang |
| `notifyUser` | `user`, `title`, `body` | Sendet eine interne Benachrichtigung an eine Person, die das Postfach aktuell lesen kann |
| `automaticReply` | `message`, `conversation`, `sender`, `subject`, `body`, `schedule` | Stellt eine geschützte automatische Antwort in die Warteschlange |
| `aiGenerateText` | `prompt`, `saveAs` | Erzeugt begrenzten Text; `input`, `model` und `maxOutputChars` sind optional |
| `aiClassify` | `input`, `prompt`, `choices`, `saveAs` | Gibt genau einen deklarierten Auswahlwert zurück |
| `aiClassifyMany` | `input`, `prompt`, `choices`, `saveAs` | Gibt eine eindeutige Teilmenge der deklarierten Auswahlwerte zurück |
| `aiExtractData` | `input`, `prompt`, `fields`, `saveAs` | Gibt ein Objekt zurück, das anhand deklarierter begrenzter Felder validiert wurde |
| `linkSpaceItem` | `conversation`, `item` | Verknüpft eine Unterhaltung mit einer vorhandenen beschreibbaren Aufgabe oder einem Termin in Spaces |
| `createSpaceEvent` | `conversation`, `space`, `column`, `event` | Erstellt wiederholungssicher einen Termin mit einer Unterhaltungsreferenz |
| `setVariable` | `name`, `value` | Speichert einen Wert für spätere Schritte |
| `succeed` | `message` | Beendet die Ausführung erfolgreich |
| `fail` | `message` | Beendet die Ausführung mit einem nicht wiederholbaren Workflow-Fehler |

Felder für Ordner, lokale Tags, Personen und Absender akzeptieren einen eindeutigen zugänglichen Namen oder eine ID. Die gespeicherte Version bindet diese Katalogwerte vor der Aktivierung. Die Antwortzeiten schreibst du direkt ins YAML, und Mail prüft sie als Teil der Version.

Verwaltete Automatisierungen für eingehende E-Mails erzeugen `linkSpaceItem` und `createSpaceEvent`. Sie nutzen die verschlüsselte, widerrufbare Spaces-Delegation, die mit dieser Automatisierung gespeichert ist. Unabhängige, von Hand geschriebene Mail-Workflows können sie deshalb nicht nutzen.

### Felder, Standardwerte, Ausgaben und Limits prüfen

Referenzfelder namens `message`, `conversation` oder `draft` akzeptieren einen rohen Wertepfad mit höchstens 500 Zeichen. Selektoren für Ordner, Schlüsselwort, Tag, Absender und Person haben ebenfalls höchstens 500 Zeichen. Variablennamen in `name` und `saveAs` sind Bezeichner mit höchstens 120 Zeichen.

| Aktionen | Zusätzliche Felder und Standardwerte | Ausgabe | Limit pro Ausführung |
| --- | --- | --- | --- |
| `addKeyword`, `removeKeyword` | `keyword`: 1–500 Zeichen | keine | 1 `maxKeywordChanges` |
| `moveMessage` | zugänglicher `folder`-Name oder zugängliche ID | keine | 1 `maxMoves` |
| `copyMessage` | zugänglicher `folder`-Name oder zugängliche ID | keine | 1 `maxCopies` |
| `archiveMessage`, `trashMessage`, `junkMessage` | keine zusätzlichen Felder | keine | 1 `maxMoves` |
| `addFlag`, `removeFlag` | `flag`: `seen`, `answered`, `flagged` oder `draft` | keine | 1 `maxFlagChanges` |
| `assignConversation`, `setConversationStatus`, `setConversationSummary`, `ensureConversationReference`, `addLocalTag`, `removeLocalTag`, `addComment` | Zusammenfassungs- und Kommentartext: höchstens 50.000 Zeichen | Referenz nur, wenn `saveAs` gesetzt ist | 1 `maxCollaborationChanges` |
| `createDraft`, `createReplyDraft` | `format`: standardmäßig `markdown` oder `plain`; Betreff: höchstens 998 Zeichen; Text: höchstens 2 MiB; jede To-, Cc- oder Bcc-Liste: höchstens 200 Adressen | erforderliches `saveAs` erhält `mail.draft` | 1 `maxDrafts` |
| `scheduleDraftSend` | `scheduledAt`: ISO-Zeitstempel mit höchstens 100 Zeichen | keine | 1 `maxSends` |
| `notifyUser` | Titel: höchstens 160 Zeichen; Text: höchstens 2.000 Zeichen | keine | 1 `maxNotifications` |
| `automaticReply` | `format`: standardmäßig `plain`; `inactiveBehavior`: standardmäßig `defer`; `minimumIntervalHours`: standardmäßig 24, von 1 bis 8.760 | keine | 1 `maxDrafts` und 1 `maxSends` |
| `aiGenerateText` | Prompt: 1–20.000 Zeichen; `maxOutputChars`: standardmäßig 4.000, von 1 bis 20.000; optionale Felder `input` und `model` | erforderliches `saveAs` erhält `core.text` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiClassify` | Prompt: 1–20.000 Zeichen; 2–50 eindeutige Auswahlwerte mit 1–200 Zeichen; optionales `model` | erforderliches `saveAs` erhält einen deklarierten Auswahlwert als `core.text` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiClassifyMany` | dieselben Grenzen für Auswahlwerte; `minChoices`: standardmäßig 0; `maxChoices`: standardmäßig alle Auswahlwerte; beide von 0 bis 50 | erforderliches `saveAs` erhält ein geordnetes, eindeutiges `core.textArray` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiExtractData` | 1–40 eindeutig benannte Felder; Typen sind `text`, `number`, `boolean`, `date_time` oder `enum`; Enum-Felder benötigen 1–50 Auswahlwerte; Text kann `maxLength` festlegen | erforderliches `saveAs` erhält ein striktes `core.value`-Objekt | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `linkSpaceItem`, `createSpaceEvent` | stabile sechsstellige Spaces-IDs; ein Termin benötigt einen gültigen Titel und einen ISO-Start-/Endzeitraum | verknüpfte Referenz oder erstellter Termin | 1 `maxCollaborationChanges`; ein Termin verbraucht zusätzlich 1 `maxTargets` |
| `setVariable` | beliebiger JSON-kompatibler `value` | `name` erhält `core.value` | keine |
| `succeed`, `fail` | Meldung für Betriebspersonal: höchstens 1.000 Zeichen | Endzustand | keine |

`createDraft.to` ist erforderlich. `cc` und `bcc` sind optional. `createReplyDraft` leitet Empfänger und Betreff aus der Quellnachricht ab. Das Feld `model` akzeptiert die ID eines aktivierten KI-Modellprofils mit höchstens 120 Zeichen. KI-Ausgaben, Entwurfsausgaben, Referenzausgaben und Variablen sind nur für spätere Schritte im selben erreichbaren Gültigkeitsbereich sichtbar.

Ein erreichbarer Pfad kann nicht mehrere Anbieteränderungen auf dieselbe Nachricht anwenden. Mail lehnt zum Beispiel einen Zweig ab, der ein Schlüsselwort ergänzt und dieselbe Nachricht danach verschiebt. Brauchst du beides, teile es auf separate Workflows auf.

`createDraft` und `createReplyDraft` erzeugen immer `deliveryClass: normal`. `createReplyDraft` leitet Empfänger und Betreff aus der Quellnachricht ab, erhält den Antwortverlauf und bleibt mit seiner Unterhaltung verknüpft. Nur `automaticReply` kann `deliveryClass: automatic_reply` erzeugen. Normale Workflow-Sendungen erhalten daher weder Header für automatische Antworten noch einen leeren Envelope-Absender. `scheduleDraftSend` akzeptiert nur ein `mail.draft`-Ergebnis, das zuvor im selben erreichbaren Gültigkeitsbereich erstellt wurde.

`forEach` gehört zur gemeinsamen Workflow-Grammatik, aber das Mail-Vokabular unterstützt es bewusst nicht. Mail-Workflows verarbeiten jeweils ein materialisiertes Nachrichtenziel.

## E-Mails mit KI klassifizieren und Entwürfe erstellen {icon="sparkles"}

Mail aktiviert die gemeinsamen KI-Aktionen ausdrücklich. KI erzeugt nur einen Wert. Tags, Zuweisung, Ordner, Entwürfe und Versand bleiben Effekte von Mail-Aktionen, mit dem normalen Zugriff auf das Postfach und den Ausführungslimits.

Dieses Beispiel ordnet eine Nachricht mehreren Labels zu. Es nutzt die exakte Array-Zugehörigkeit, um die Unterhaltung zu taggen und zuzuweisen, und erstellt einen Entwurf, ohne ihn zu senden:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiClassifyMany:
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
      prompt: Wähle jede passende Kategorie aus.
      choices: [finance, urgent, support]
      maxChoices: 3
      saveAs: categories
  - if:
      includes:
        - "${{ categories }}"
        - finance
    then:
      - addLocalTag:
          conversation: inputs.conversation
          tag: Finance
  - if:
      includes:
        - "${{ categories }}"
        - urgent
    then:
      - addLocalTag:
          conversation: inputs.conversation
          tag: Urgent
      - assignConversation:
          conversation: inputs.conversation
          user: Alice Example
  - aiGenerateText:
      prompt: Verfasse einen knappen Antwortentwurf. Erfinde keine Fakten und verspreche keine Frist.
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
      maxOutputChars: 4000
      saveAs: reply
  - createReplyDraft:
      message: inputs.message
      conversation: inputs.conversation
      sender: Support
      body: "{{ reply }}"
      format: plain
      saveAs: draft
```

Verwende `aiClassify`, wenn genau ein Auswahlwert zulässig ist. Verwende `aiClassifyMany`, wenn null oder mehr Auswahlwerte zutreffen können. `minChoices` und `maxChoices` begrenzen das Ergebnis. Auswahlwerte sind exakte Werte, keine frei formulierte Modellausgabe.

`aiExtractData` deklariert seinen vollständigen Ausgabevertrag, statt ein frei formuliertes JSON Schema zu akzeptieren. Dieses erzeugte Beispiel einer verwalteten Automatisierung extrahiert Termindaten und erstellt einen verknüpften Spaces-Termin. Wenn das Modell keinen gültigen Titel oder Zeitraum liefern kann, stoppt die strukturierte Validierung oder die `ready`-Schutzbedingung den Erstellungsschritt:

```yaml
inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiExtractData:
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
        receivedAt: "${{ inputs.message.receivedAt }}"
      prompt: Extrahiere Kalenderdetails. Interpretiere relative Datumsangaben in Europe/Berlin. Erfinde keine fehlenden Fakten.
      fields:
        - { name: ready, type: boolean, description: "Nur wahr, wenn Titel, Beginn und Ende eindeutig sind." }
        - { name: title, type: text, description: Knapp formulierter Termintitel., required: false, maxLength: 500 }
        - { name: startsAt, type: date_time, description: ISO-Beginn mit Offset., required: false }
        - { name: endsAt, type: date_time, description: ISO-Ende mit Offset., required: false }
        - { name: allDay, type: boolean, description: Gibt an, ob der Termin ganztägig ist. }
      saveAs: eventData
  - createSpaceEvent:
      conversation: inputs.conversation
      space: Space1
      column: Col001
      event: "${{ eventData }}"
```

Die allgemeinen Feldtypen sind `text`, `number`, `boolean`, `date_time` und `enum`. Optionale Felder dürfen fehlen. Die Ausgabe lehnt nicht deklarierte Felder ab. Der geführte Editor für eingehende E-Mails stellt automatisch bereit: den festen Vertrag für Terminfelder, eine ausdrückliche IANA-Zeitzone, die Empfangszeit der Nachricht und die Schutzbedingung gegen erfundene Angaben.

Ein optionales `model` wählt für eine Aktion ein aktiviertes Profil aus. Andernfalls verwendet Mail zuerst das Workflow-Modell der Plattform, dann das Hintergrundmodell und anschließend den Plattformstandard. Jede neu erstellte KI-Aufgabe zählt einmal gegen das Limit `maxAiCalls`. Standardmäßig liegt dieses Limit bei 10 pro Ausführung.

KI-Aufgaben überstehen Neustarts von Workern. Brichst du die Mail-Ausführung ab, stoppt sie die laufende Inferenz, wo das möglich ist, und verwirft verspätete Ausgaben. Eine Testausführung kann die KI-Ausgabe nicht vorhersagen. Deshalb meldet sie den nicht verfügbaren Wert, statt mit einer erfundenen Klassifizierung oder einem erfundenen Entwurf fortzufahren.

Mail speichert Prompts, Eingaben und Ausgaben mit der dauerhaften Aufgabe. Nimm nur die Nachrichtenfelder auf, die für die Entscheidung benötigt werden. Behalte erzeugte Antworten als Entwürfe, wenn eine Person sie prüfen soll. Ergänze `scheduleDraftSend` nur, wenn der Versand ohne Prüfung bewusst genehmigt ist.

Ein Workflow mit dem Trigger `messageReceived` kann `scheduleDraftSend` gar nicht nutzen. Antworten auf eingehende E-Mails müssen über `automaticReply` und dessen Schleifenschutz laufen.

Um eine fortlaufende Zusammenfassung der Unterhaltung zu pflegen, übergib sowohl die aktuelle Zusammenfassung als auch die neu empfangene Nachricht an `aiGenerateText`. Übergib anschließend dessen normale Textausgabe an `setConversationSummary`:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiGenerateText:
      prompt: Aktualisiere die Zusammenfassung mit dauerhaften Fakten und dem aktuellen nächsten Schritt. Halte sie knapp.
      input:
        existingSummary: "${{ inputs.conversation.summary }}"
        newMessage:
          sender: "${{ inputs.message.fromAddress }}"
          subject: "${{ inputs.message.subject }}"
          body: "${{ inputs.message.bodyText }}"
      maxOutputChars: 1200
      saveAs: updatedSummary
  - setConversationSummary:
      conversation: inputs.conversation
      summary: "{{ updatedSummary }}"
```

Die Zusammenfassung hat eine eigene optimistische Revision. Wenn eine Person sie bearbeitet, während KI noch ausgeführt wird, schlägt die verzögerte Workflow-Aktion fehl, statt die neuere menschliche Bearbeitung zu überschreiben.

## Eine Unterhaltungsreferenz vergeben {icon="book-2"}

Richte das Referenzformat des Postfachs unter **Automatisierungen → Workflows** ein und schalte es ein, oder direkt im Editor einer **Empfangsbestätigung mit Referenznummer**:

```yaml
inputs:
  conversation:
    type: mailConversation
    required: true
steps:
  - ensureConversationReference:
      conversation: inputs.conversation
      saveAs: reference
  - setConversationStatus:
      conversation: inputs.conversation
      status: waiting
  - succeed:
      message: "{{ reference.value }} vergeben"
```

Du kannst die Aktion gefahrlos wiederholen. Sie vergibt für dieselbe Unterhaltung keine zweite Referenz. Wenn `saveAs` vorhanden ist, können spätere Schritte im selben Gültigkeitsbereich Folgendes verwenden:

- `{{ reference.value }}` für die permanente menschenlesbare Referenz wie `REF-K7M3-P9QX-2F4N`.
- `{{ reference.created }}`, um eine neue Vergabe von einem vorhandenen Wert zu unterscheiden.
- `{{ reference.conversationId }}` und `{{ reference.conversationRevision }}` für nachfolgende Workflow-Logik.

## Eine geschützte automatische Antwort senden {icon="send"}

`automaticReply` ist nur gültig, wenn jeder Trigger im Workflow `messageReceived` ist.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - automaticReply:
      message: inputs.message
      conversation: inputs.conversation
      sender: Support
      subject: "Re: {{ inputs.message.subject }}"
      body: "Vielen Dank für deine Nachricht. Wir antworten während unserer Geschäftszeiten."
      format: markdown
      schedule:
        mode: windows
        timeZone: Europe/Berlin
        activeRanges: []
        weeklyWindows:
          - weekday: 1
            start: "09:00"
            end: "17:00"
          - weekday: 2
            start: "09:00"
            end: "17:00"
          - weekday: 3
            start: "09:00"
            end: "17:00"
          - weekday: 4
            start: "09:00"
            end: "17:00"
          - weekday: 5
            start: "09:00"
            end: "17:00"
        exceptions:
          - date: "2026-12-25"
            closed: true
            windows: []
      inactiveBehavior: defer
      minimumIntervalHours: 24
```

Optionale Felder und Standardwerte:

- `format`: standardmäßig `plain` oder `markdown`
- `inactiveBehavior`: standardmäßig `defer` oder `skip`
- `minimumIntervalHours`: standardmäßig `24`, von `0` bis `8760`

Die Absenderidentität muss bestätigt und für automatische Antworten zugelassen sein. Mail unterdrückt Schleifen, Massen- und Mailinglisten-E-Mails, Zustellstatusnachrichten, wiederholte Antworten auf eine Nachricht und Empfänger, die noch vom Wiederholungsschutz erfasst sind.

`schedule` ist ausdrücklich angegeben. Verwende `{ mode: always }` für eine immer aktive Antwort oder `mode: windows` mit `timeZone`, `activeRanges`, `weeklyWindows` und `exceptions`.

:::reference
- **Grenzen:** Ein Zeitplan mit Zeitfenstern akzeptiert höchstens 32 aktive Zeiträume, 64 wöchentliche Zeitfenster, 366 Ausnahmen und 32 Zeitfenster innerhalb einer Ausnahme.
- **Wochentage:** `weekday` verwendet ISO-Zahlen von `1` für Montag bis `7` für Sonntag.
- **Zeiten:** Zeiten sind lokale `HH:mm`-Werte in der eingerichteten IANA-Zeitzone. Zeitfenster dürfen sich weder überschneiden noch über Mitternacht gehen. `24:00` ist nur als Ende zulässig.
- **Zeiträume:** Eine leere Liste `activeRanges` wiederholt sich wöchentlich ohne Datumsgrenze. Jeder Zeitraum nutzt ein einschließendes `from`-Datum und ein einschließendes `to`-Datum oder `null`.
- **Ausnahmen:** Eine Datumsausnahme ersetzt die normalen wöchentlichen Zeitfenster. `closed: true` schaltet das ganze Datum aus. `closed: false` nutzt nur die aufgeführten Zeitfenster der Ausnahme.
:::

## Bedingungen hinzufügen {icon="search"}

Ein `if`-Schritt nimmt eine Bedingung und eine nicht leere `then`-Liste an. `else` ist optional.

Unterstützte Vergleiche:

- `equals` und `notEquals`
- `textEquals`, `contains`, `startsWith` und `endsWith` für normalisierten Text ohne Beachtung der Groß-/Kleinschreibung
- `includes` für die exakte Zugehörigkeit zu einem Array wie der Ausgabe von `aiClassifyMany`
- `exists` für eine rohe Referenz
- rekursive `all`, `any` und `not`

`equals`, `notEquals` und `includes` vergleichen exakte Werte. `textEquals`, `contains`, `startsWith` und `endsWith` normalisieren Unicode-Text und ignorieren die Groß-/Kleinschreibung.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
steps:
  - if:
      all:
        - exists: inputs.message.subject
        - any:
            - startsWith:
                - "${{ inputs.message.subject }}"
                - "[Urgent]"
            - contains:
                - "${{ inputs.message.bodyText }}"
                - Dienst nicht verfügbar
        - not:
            equals:
              - "${{ inputs.conversation.workStatus }}"
              - done
    then:
      - assignConversation:
          conversation: inputs.conversation
          user: Alice Example
    else:
      - succeed:
          message: Keine dringende Zuweisung erforderlich.
```

## Mit `switch` verzweigen {icon="point"}

`switch` vergleicht einen Wert mit geordneten `cases`. Das optionale `default` wird ausgeführt, wenn kein Fall zutrifft.

```yaml
inputs:
  conversation:
    type: mailConversation
    required: true
steps:
  - switch: "${{ inputs.conversation.workStatus }}"
    cases:
      - when: needs_action
        do:
          - setVariable:
              name: result
              value: active
      - when: waiting
        do:
          - setVariable:
              name: result
              value: pending
    default:
      - succeed:
          message: Die Unterhaltung ist bereits abgeschlossen.
```

Werte, die in einem `case` erstellt werden, bleiben innerhalb dieses Falls. Braucht ein späterer Schritt einen Wert aus einem Zweig, verwende Endaktionen innerhalb der Zweige.

## Versionen und Aktivierung verstehen {icon="layout-grid"}

Jede gespeicherte Version hat eigene Ausführungslimits. `0` schaltet eine Kategorie von Effekten ab. Ausnahme ist `maxTargets`: Es muss mindestens 1 sein.

| Limit | Standardwert | Maximum |
| --- | ---: | ---: |
| `maxTargets` | 1.000 | 50.000 |
| `maxMoves`, `maxCopies`, `maxSends`, `maxDrafts`, `maxNotifications` | 1.000 | 50.000 |
| `maxFlagChanges`, `maxKeywordChanges`, `maxCollaborationChanges` | 2.000 | 100.000 |
| `maxAiCalls` | 10 | 1.000 |

Die Ausführungslimits gehören zur unveränderlichen Version und gelten für eine Ausführung. Die Laufzeit zählt die passende Kategorie unmittelbar, bevor ein Effekt beginnt. Sie lässt die Ausführung fehlschlagen, statt die Grenze zu überschreiten. Idempotente Wiederholungen nutzen denselben Effekt erneut und erstellen keinen weiteren.

- **Workflow erstellen** speichert Version 1, lässt sie aber inaktiv.
- **Version speichern** erstellt eine weitere unveränderliche Version. Eine ältere Version wird nie bearbeitet.
- **Aktivieren** registriert die Trigger der ausgewählten aktuellen Version.
- **Aktualisierung verfügbar** bedeutet, dass sich die aktuell gespeicherte Version von der aktiven Version unterscheidet.
- **Deaktivieren** stoppt die zukünftige automatische Materialisierung von Triggern. Der vorhandene Ausführungsverlauf bleibt erhalten.

Die Änderung eines zugänglichen Ordners oder Absenders ändert eine gespeicherte Version nicht. Mail wertet das Referenzmuster des Postfachs aus, wenn es eine Nummer vergibt. Vorhandene Referenzwerte bleiben unverändert. Der Zeitplan ist Teil des YAML. Um die Antwortzeiten zu ändern, speichere eine neue Workflow-Version und aktiviere sie ausdrücklich.

## Ausführungen validieren und prüfen {icon="layout-list"}

**Prüfen** kontrolliert den Quelltext und die Katalogbindungen, führt aber keine Schritte aus. Mail-Workflows starten nur über ihre aktiven Trigger `messageReceived` oder `schedule`. Es gibt keinen eigenen Weg für manuelle Ausführungen oder rückwirkende Verarbeitung.

Um Workflows zu lesen und zu prüfen, brauchst du Zugriff **Ansehen** auf das Postfach. Um Versionen zu erstellen, Metadaten zu ändern, zu aktivieren und zu deaktivieren, brauchst du Zugriff **Verwalten**. Nur die Cloud-Administration kann Ausführungen über alle Apps prüfen, abbrechen und ungewisse Effekte klären.

Jede Aktion prüft erneut den Zugriff auf das Postfach, den die Workflow-Version gebunden hat. Verliert die Person, die aktiviert hat, später ihren persönlichen Zugriff, läuft eine bereits angenommene Ausführung weiter. Deaktivierung oder Ersetzung verhindert neue Ausführungen. Fordere den Abbruch an, um noch nicht abgeschlossene Effekte einer angenommenen Ausführung zu stoppen. Anbieterbefehle binden zusätzlich die Ausführungsgeneration des Kernels, sodass ein Worker, der seine Lease verloren hat, den E-Mail-Anbieter nicht erreichen kann.

Die Cloud-Administration prüft den Laufzeitverlauf unter **Administration → Systembeobachtung → Workflows**. Die gemeinsame Ansicht zeigt über alle Apps Ausführungen, Schrittergebnisse, Effekte, Quellereignisse, Fehler und Einträge, die Aufmerksamkeit brauchen. Die entsprechenden CLI-Befehle lauten:

```bash
cld admin workflows runs --app mail
cld admin workflows show <run-id>
cld admin workflows effects --app mail
cld admin workflows events --app mail
```

`cld admin workflows cancel <run-id> --yes` verhindert spätere Effekte, macht abgeschlossene Arbeit aber nicht rückgängig. Kläre ein ungewisses externes Ergebnis erst, nachdem du es beim Anbieter geprüft hast. Halte diese Entscheidung anschließend mit `cld admin workflows resolve` fest.

Einrichtungsaufgaben und betriebliche Auswirkungen beschreibt [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation).
