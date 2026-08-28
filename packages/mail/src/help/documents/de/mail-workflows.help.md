---
id: mail-workflows
title: YAML-Referenz für Mail-Workflows
icon: ti ti-code
description: Referenz für Eingaben, Trigger, Aktionen, Bedingungen, Ausdrücke, Grenzen und Beispiele von Mail-Workflows.
order: 70
---

Mail-Workflow-YAML hat drei Schlüssel auf oberster Ebene: `inputs`, `triggers` und `steps`. Nur `steps` ist erforderlich. Name, Beschreibung, Priorität, Effektbudget, gespeicherte Versionen und Aktivierungsstatus des Workflows werden außerhalb des YAML bearbeitet.

Der Workflow-Quelltext ist auf 200.000 Zeichen begrenzt. Ein gespeicherter Workflow-Name umfasst 1–160 Zeichen, seine optionale Beschreibung höchstens 2.000 Zeichen und seine Priorität eine ganze Zahl von -1.000 bis 1.000 mit dem Standardwert 100. Niedrigere Prioritätswerte werden zuerst ausgeführt, wenn mehrere Mail-Workflows dasselbe Ereignis annehmen.

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

Wähle vor dem Speichern **Validieren**. Die Validierung prüft striktes YAML, das Mail-Vokabular, Wertepfade, zugängliche Katalognamen und unvereinbare Aktionskombinationen.

## Eingaben deklarieren {icon="point"}

Mail unterstützt zwei Eingabetypen:

| Typ | Wert |
| --- | --- |
| `mailMessage` | Eine Nachricht in diesem Postfach |
| `mailConversation` | Eine Unterhaltung in diesem Postfach |

Jeder Eingabename muss mit einem Buchstaben oder Unterstrich beginnen und darf nur Buchstaben, Ziffern und Unterstriche enthalten. `required` hat den Standardwert `false`; setze `required: true`, wenn jeder Aufrufer oder Trigger die Eingabe bereitstellen muss. Ein Trigger muss jede erforderliche Eingabe in seinem `with`-Block binden. `steps` muss mindestens einen Schritt enthalten. Unbekannte Stammschlüssel oder Aktionseigenschaften werden abgelehnt.

Ein Workflow ohne `triggers` kann validiert und als inaktiver Entwurf gespeichert, aber nicht aktiviert werden. Mail hat bewusst keine separate API für manuelle Ausführungen oder Zielabfragen.

Mail akzeptiert höchstens 20 Eingaben, 500 Schritte, 20 verschachtelte Schrittebenen, 500 Bedingungen und 20 verschachtelte Bedingungsebenen. Diese Grenzen gelten nach dem Parsen des vollständigen Workflows einschließlich aller Zweige.

## Automatische Trigger verwenden {icon="route"}

### `messageReceived`

`messageReceived` startet einmal für eine stabile, neu importierte Nachricht. Der Trigger stellt Folgendes bereit:

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

Trigger-Werte sind nur während der Bindung von `with` vorhanden. Geplante Mail-Workflows sind daher derzeit auf Schritte beschränkt, die keine empfangene Nachricht oder Unterhaltung benötigen. `automaticReply` kann nicht über einen Zeitplan-Trigger ausgeführt werden.

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

- `inputs.conversation.id`, `subject`, `summary`, `summaryRevision`, `assigneeUserId`
- `inputs.conversation.workStatus`, `latestMessageAt`

Ressourcen-IDs, die einem Workflow in Mail bereitgestellt werden, verwenden dieselben stabilen sechsstelligen IDs wie Mail-URLs und Capabilities. Anbieterreferenzen und Datenbank-UUIDs sind intern und keine Workflow-Felder.

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

Variablen, die innerhalb eines Zweigs erstellt werden, sind außerhalb dieses Zweigs nicht verfügbar. Derselbe Variablenname darf in einem Gültigkeitsbereich nicht zweimal definiert werden.

## Mail-Aktionen verwenden {icon="route"}

| Aktion | Erforderliche Felder | Auswirkung |
| --- | --- | --- |
| `addKeyword` | `message`, `keyword` | Ergänzt ein übertragbares Anbieter-Schlüsselwort |
| `removeKeyword` | `message`, `keyword` | Entfernt ein übertragbares Anbieter-Schlüsselwort |
| `moveMessage` | `message`, `folder` | Verschiebt die Nachricht in einen zugänglichen Anbieterordner |
| `copyMessage` | `message`, `folder` | Kopiert die Nachricht in einen zugänglichen Anbieterordner |
| `archiveMessage` | `message` | Verschiebt die Nachricht in den Archivordner des Postfachs |
| `trashMessage` | `message` | Verschiebt die Nachricht in den Papierkorbordner des Postfachs |
| `junkMessage` | `message` | Verschiebt die Nachricht in den Spamordner des Postfachs |
| `addFlag` / `removeFlag` | `message`, `flag` | Ändert `seen`, `answered`, `flagged` oder `draft` über das Befehlsjournal des Anbieters |
| `assignConversation` | `conversation`, `user` | Weist anhand eines zugänglichen Personennamens oder einer ID zu; `null` hebt die Zuweisung auf |
| `setConversationStatus` | `conversation`, `status` | Setzt `needs_action`, `waiting` oder `done` |
| `setConversationSummary` | `conversation`, `summary` | Ersetzt die bearbeitbare Zusammenfassung der Unterhaltung |
| `ensureConversationReference` | `conversation`; optional `saveAs` | Vergibt die permanente Postfachreferenz oder verwendet sie erneut und speichert optional das Ergebnis |
| `addLocalTag` / `removeLocalTag` | `conversation`, `tag` | Ändert einen postfachlokalen Tag der Unterhaltung |
| `addComment` | `conversation`, `body` | Ergänzt einen internen Kommentar, der der Workflow-Version zugeordnet ist |
| `createDraft` | `sender`, `to`, `subject`, `body`, `saveAs` | Erstellt für einen späteren Schritt einen Workflow-Entwurf mit normaler Zustellung |
| `createReplyDraft` | `message`, `conversation`, `sender`, `body`, `saveAs` | Erstellt in der Quellunterhaltung einen prüfbaren Antwortentwurf |
| `scheduleDraftSend` | `draft`, `scheduledAt` | Plant den Versand eines erstellten Entwurfs mit normaler Zustellung über den dauerhaften Postausgang |
| `notifyUser` | `user`, `title`, `body` | Sendet eine interne Benachrichtigung an eine Person mit aktuellem Lesezugriff auf das Postfach |
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

Felder für Ordner, lokale Tags, Personen und Absender akzeptieren einen eindeutigen zugänglichen Namen oder eine ID. Die gespeicherte Version bindet diese Katalogwerte vor der Aktivierung. Die Antwortzeiten stehen direkt im YAML und werden als Teil der Version validiert.

`linkSpaceItem` und `createSpaceEvent` werden von verwalteten Automatisierungen für eingehende E-Mails ausgegeben. Sie verwenden die verschlüsselte, widerrufbare Spaces-Delegation, die mit dieser Automatisierung gespeichert ist. Daher stehen sie nicht für unabhängige, manuell geschriebene Mail-Workflows zur Verfügung.

### Felder, Standardwerte, Ausgaben und Budgets prüfen

Referenzfelder namens `message`, `conversation` oder `draft` akzeptieren einen rohen Wertepfad und sind auf 500 Zeichen begrenzt. Selektoren für Ordner, Schlüsselwort, Tag, Absender und Person sind ebenfalls auf 500 Zeichen begrenzt. Variablennamen in `name` und `saveAs` sind Bezeichner mit höchstens 120 Zeichen.

| Aktionen | Zusätzliche Felder und Standardwerte | Ausgabe | Budget pro Ausführung |
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
| `automaticReply` | `format`: standardmäßig `plain`; `inactiveBehavior`: standardmäßig `defer`; `minimumIntervalHours`: standardmäßig 24, von 0 bis 8.760 | keine | 1 `maxDrafts` und 1 `maxSends` |
| `aiGenerateText` | Prompt: 1–20.000 Zeichen; `maxOutputChars`: standardmäßig 4.000, von 1 bis 20.000; optionale Felder `input` und `model` | erforderliches `saveAs` erhält `core.text` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiClassify` | Prompt: 1–20.000 Zeichen; 2–50 eindeutige Auswahlwerte mit 1–200 Zeichen; optionales `model` | erforderliches `saveAs` erhält einen deklarierten Auswahlwert als `core.text` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiClassifyMany` | dieselben Grenzen für Auswahlwerte; `minChoices`: standardmäßig 0; `maxChoices`: standardmäßig alle Auswahlwerte; beide von 0 bis 50 | erforderliches `saveAs` erhält ein geordnetes, eindeutiges `core.textArray` | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `aiExtractData` | 1–40 eindeutig benannte Felder; Typen sind `text`, `number`, `boolean`, `date_time` oder `enum`; Enum-Felder benötigen 1–50 Auswahlwerte; Text kann `maxLength` festlegen | erforderliches `saveAs` erhält ein striktes `core.value`-Objekt | 1 `maxAiCalls` für eine neu erstellte Aufgabe |
| `linkSpaceItem`, `createSpaceEvent` | stabile sechsstellige Spaces-IDs; ein Termin benötigt einen gültigen Titel und einen ISO-Start-/Endzeitraum | verknüpfte Referenz oder erstellter Termin | 1 `maxCollaborationChanges`; ein Termin verbraucht zusätzlich 1 `maxTargets` |
| `setVariable` | beliebiger JSON-kompatibler `value` | `name` erhält `core.value` | keine |
| `succeed`, `fail` | Meldung für Betriebspersonal: höchstens 1.000 Zeichen | Endzustand | keine |

`createDraft.to` ist erforderlich; `cc` und `bcc` sind optional. `createReplyDraft` leitet Empfänger und Betreff aus der Quellnachricht ab. Das Feld `model` akzeptiert die ID eines aktivierten AI-Modellprofils mit höchstens 120 Zeichen. AI-Ausgaben, Entwurfsausgaben, Referenzausgaben und Variablen sind nur für spätere Schritte im selben erreichbaren Gültigkeitsbereich sichtbar.

Ein erreichbarer Pfad kann nicht mehrere Anbieteränderungen auf dieselbe Nachricht anwenden. Beispielsweise wird es abgelehnt, in einem Zweig ein Schlüsselwort zu ergänzen und dieselbe Nachricht anschließend zu verschieben. Teile diese Vorgänge auf separate Workflows auf, wenn beide erforderlich sind.

`createDraft` und `createReplyDraft` erzeugen immer `deliveryClass: normal`. `createReplyDraft` leitet Empfänger und Betreff aus der Quellnachricht ab, erhält den Antwortverlauf und bleibt mit seiner Unterhaltung verknüpft. Nur `automaticReply` kann `deliveryClass: automatic_reply` erzeugen. Normale Workflow-Sendungen erhalten daher weder Header für automatische Antworten noch einen leeren Envelope-Absender. `scheduleDraftSend` akzeptiert nur ein `mail.draft`-Ergebnis, das zuvor im selben erreichbaren Gültigkeitsbereich erstellt wurde.

`forEach` gehört zur gemeinsamen Workflow-Grammatik, wird vom Mail-Vokabular aber bewusst nicht unterstützt. Mail-Workflows verarbeiten jeweils ein materialisiertes Nachrichtenziel.

## E-Mails mit AI klassifizieren und Entwürfe erstellen {icon="sparkles"}

Mail aktiviert die gemeinsamen AI-Aktionen ausdrücklich. AI erzeugt nur einen Wert. Mail-Aktionen übernehmen weiterhin Tag-, Zuweisungs-, Ordner-, Entwurfs- und Versandwirkungen unter den normalen Postfachberechtigungen und Budgets.

Dieses Beispiel ordnet eine Nachricht mehreren Labels zu, verwendet die exakte Array-Zugehörigkeit, um die Unterhaltung zu taggen und zuzuweisen, und erstellt einen Entwurf, ohne ihn zu senden:

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

Verwende `aiClassify`, wenn genau ein Auswahlwert zulässig ist. Verwende `aiClassifyMany`, wenn null oder mehr Auswahlwerte zutreffen können; `minChoices` und `maxChoices` begrenzen das Ergebnis. Auswahlwerte sind exakte Werte, keine frei formulierte Modellausgabe.

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

Die allgemeinen Feldtypen sind `text`, `number`, `boolean`, `date_time` und `enum`. Optionale Felder dürfen fehlen; die Ausgabe lehnt nicht deklarierte Felder ab. Der geführte Editor für eingehende E-Mails stellt automatisch den festen Vertrag für Terminfelder, eine ausdrückliche IANA-Zeitzone, die Empfangszeit der Nachricht und die Schutzbedingung gegen erfundene Angaben bereit.

Ein optionales `model` wählt für eine Aktion ein aktiviertes Profil aus. Andernfalls verwendet Mail zuerst das Workflow-Modell der Plattform, dann das Hintergrundmodell und anschließend den Plattformstandard. Jede neu erstellte AI-Aufgabe verbraucht eine Einheit des Budgets `maxAiCalls`; Mail setzt dieses Budget standardmäßig auf 10 pro Ausführung.

AI-Aufgaben überstehen Neustarts von Workern. Wird die Mail-Ausführung abgebrochen, bricht sie die laufende Inferenz ab, sofern dies unterstützt wird, und verwirft verspätete Ausgaben. Eine Testausführung kann die AI-Ausgabe nicht vorhersagen. Deshalb meldet sie den nicht verfügbaren Wert, statt mit einer erfundenen Klassifizierung oder einem erfundenen Entwurf fortzufahren.

Prompts, Eingaben und Ausgaben werden mit der dauerhaften Aufgabe gespeichert. Nimm nur die Nachrichtenfelder auf, die für die Entscheidung benötigt werden. Behalte erzeugte Antworten als Entwürfe, wenn eine Person sie prüfen soll. Ergänze `scheduleDraftSend` nur, wenn der unbeaufsichtigte Versand bewusst freigegeben wurde.

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

Die Zusammenfassung hat eine eigene optimistische Revision. Wenn eine Person sie bearbeitet, während AI noch ausgeführt wird, schlägt die verzögerte Workflow-Aktion fehl, statt die neuere menschliche Bearbeitung zu überschreiben.

## Eine Unterhaltungsreferenz vergeben {icon="book-2"}

Konfiguriere und aktiviere das Referenzformat des Postfachs unter **Automatisierungen > Workflows** oder direkt in einem Editor für Referenzbestätigungen:

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

Die Aktion kann sicher wiederholt werden und vergibt für dieselbe Unterhaltung keine zweite Referenz. Wenn `saveAs` vorhanden ist, können spätere Schritte im selben Gültigkeitsbereich Folgendes verwenden:

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

Der Absender muss für automatische Antworten verifiziert und aktiviert sein. Mail unterdrückt Schleifen, Massen- und Mailinglisten-E-Mails, Zustellstatusnachrichten, wiederholte Antworten auf eine Nachricht und Empfänger, die noch vom Wiederholungsschutz erfasst sind.

`schedule` ist ausdrücklich angegeben: Verwende `{ mode: always }` für eine immer aktive Antwort oder `mode: windows` mit `timeZone`, `activeRanges`, `weeklyWindows` und `exceptions`. Ein Zeitplan mit Zeitfenstern akzeptiert höchstens 32 aktive Zeiträume, 64 wöchentliche Zeitfenster, 366 Ausnahmen und 32 Zeitfenster innerhalb einer Ausnahme. `weekday` verwendet ISO-Zahlen von `1` für Montag bis `7` für Sonntag. Zeiten sind lokale `HH:mm`-Werte in der konfigurierten IANA-Zeitzone. Zeitfenster dürfen sich weder überschneiden noch über Mitternacht hinausgehen; `24:00` ist nur als Ende zulässig. Eine leere Liste `activeRanges` wiederholt sich wöchentlich ohne Datumsgrenze. Jeder Zeitraum verwendet ein einschließendes `from`-Datum und ein einschließendes `to`-Datum oder `null`. Eine Datumsausnahme überschreibt die normalen wöchentlichen Zeitfenster: `closed: true` deaktiviert das gesamte Datum, während `closed: false` nur die aufgeführten Ausnahmezeitfenster verwendet.

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

Werte, die in einem `case` erstellt werden, bleiben innerhalb dieses Falls. Verwende Endaktionen innerhalb von Zweigen, wenn ein späterer Schritt einen lokalen Wert des Zweigs benötigen würde.

## Versionen und Aktivierung verstehen {icon="layout-grid"}

Jede gespeicherte Version hat ein Effektbudget. `0` deaktiviert eine Effektkategorie mit Ausnahme von `maxTargets`, das mindestens 1 sein muss.

| Budget | Standardwert | Maximum |
| --- | ---: | ---: |
| `maxTargets` | 1.000 | 50.000 |
| `maxMoves`, `maxCopies`, `maxSends`, `maxDrafts`, `maxNotifications` | 1.000 | 50.000 |
| `maxFlagChanges`, `maxKeywordChanges`, `maxCollaborationChanges` | 2.000 | 100.000 |
| `maxAiCalls` | 10 | 1.000 |

Das Budget gehört zur unveränderlichen Version und begrenzt eine Ausführung. Die Laufzeit belastet die jeweilige Kategorie unmittelbar vor Beginn eines Effekts und lässt die Ausführung fehlschlagen, statt die Grenze zu überschreiten. Idempotente Wiederholungsversuche verwenden denselben Effekt erneut, statt einen weiteren zu erstellen.

- **Workflow erstellen** speichert Version 1, lässt sie aber inaktiv.
- **Version speichern** erstellt eine weitere unveränderliche Version. Eine ältere Version wird nie bearbeitet.
- **Aktivieren** registriert die Trigger der ausgewählten aktuellen Version.
- **Aktualisierung verfügbar** bedeutet, dass sich die aktuell gespeicherte Version von der aktiven Version unterscheidet.
- **Deaktivieren** stoppt die zukünftige automatische Materialisierung von Triggern. Der vorhandene Ausführungsverlauf bleibt erhalten.

Die Änderung eines zugänglichen Ordners oder Absenders schreibt eine gespeicherte Version nicht neu. Das Referenzmuster des Postfachs wird ausgewertet, wenn eine Nummer vergeben wird; vorhandene Referenzwerte bleiben unverändert. Wenn du die Antwortzeiten änderst, musst du eine neue Workflow-Version speichern und ausdrücklich aktivieren, weil der Zeitplan Bestandteil des YAML ist.

## Ausführungen validieren und prüfen {icon="layout-list"}

**Validieren** prüft den Quelltext und die Katalogbindungen, führt aber keine Schritte aus. Mail-Workflows starten nur über ihre aktiven Trigger `messageReceived` oder `schedule`; es gibt keinen separaten Pfad für manuelle Ausführungen oder rückwirkende Verarbeitung.

Zum Lesen und Validieren von Workflows ist Lesezugriff auf das Postfach erforderlich. Zum Erstellen von Versionen, Ändern von Metadaten, Aktivieren und Deaktivieren ist Admin-Zugriff auf das Postfach erforderlich. Die anwendungsübergreifende Prüfung von Ausführungen, deren Abbruch und die Klärung ungewisser Effekte erfordern Cloud-Administratorzugriff.

Jede Aktion prüft die an die Workflow-Version gebundene Postfachberechtigung erneut. Wenn der aktivierende Administrator später seinen persönlichen Zugriff verliert, wird eine bereits angenommene Ausführung nicht deaktiviert. Deaktivierung oder Ersetzung verhindert neue Ausführungen. Fordere den Abbruch an, um noch nicht abgeschlossene Effekte einer angenommenen Ausführung zu stoppen. Anbieterbefehle binden zusätzlich die Ausführungsgeneration des Kernels, sodass ein Worker, der seine Lease verloren hat, den E-Mail-Anbieter nicht erreichen kann.

Administratoren prüfen den Laufzeitverlauf unter **Administration > Observability > Workflows**. Die gemeinsame Ansicht zeigt Ausführungen, Schrittergebnisse, Effekte, Quellereignisse, Fehler und anwendungsübergreifend Einträge, die Aufmerksamkeit benötigen. Die entsprechenden CLI-Befehle lauten:

```bash
cld admin workflows runs --app mail
cld admin workflows show <run-id>
cld admin workflows effects --app mail
cld admin workflows events --app mail
```

`cld admin workflows cancel <run-id> --yes` verhindert spätere Effekte, macht abgeschlossene Arbeit aber nicht rückgängig. Kläre ein ungewisses externes Ergebnis erst, nachdem du es beim Anbieter geprüft hast. Halte diese Entscheidung anschließend mit `cld admin workflows resolve` fest.

Einrichtungsaufgaben und betriebliche Auswirkungen beschreibt [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation).
