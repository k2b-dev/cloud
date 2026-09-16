---
id: assistant-workflow
title: Chats und Aktionen
icon: ti ti-messages
description: Chats finden, Metadaten verwalten, Anfragen wiederholen, Chats abzweigen, Kontext komprimieren, Antworten beenden und Aktionen bearbeiten.
order: 110
---

Der Assistent trennt Projekt-Chats und allgemeine Chats in der Seitenleiste. Erstelle über die Plus-Schaltfläche neben **Projekte** ein Projekt. Projekte sind zunächst aufgeklappt und zeigen ihre zehn zuletzt aktiven Chats. Wähle das Projekt selbst, um einen Chat zu beginnen oder seinen vollständigen Chatverlauf zu durchsuchen.

## Zwischen Chats wechseln {icon="layout-list"}

:::reference
- **Projekte:** Der Bereich **Projekte** bleibt auch ohne Projekte sichtbar. Erstelle über die Plus-Schaltfläche ein Projekt mit einem Namen und optionalen Anweisungen.
- **Leerer Chat:** Wähle unter dem mittig angeordneten Eingabefeld optional ein Projekt aus, bevor du die erste Nachricht sendest. Vorschlagskarten füllen eine bearbeitbare Anfrage aus, senden sie aber nicht automatisch.
- **Projektseite:** Gib die erste Nachricht in das normale Eingabefeld ein und füge bei Bedarf Dateien hinzu. Der Assistent erstellt einen privaten Projekt-Chat, sendet die Nachricht und öffnet anschließend die normale Chatansicht. Unter dem Eingabefeld kannst du vorhandene Projekt-Chats durchsuchen und durchblättern.
- **Projektkontext:** Die Projektseite zeigt Anweisungen, Wissen, Bilder, Dateien und Referenzen des Projekts. Personen mit Schreibzugriff können diesen gemeinsamen Kontext dort ergänzen oder bearbeiten.
- **Allgemeine Chats:** Bis zu 15 Chats ohne Projekt erscheinen im Bereich **Chats** unter den Projekten. Über **Alle Chats anzeigen** öffnest du den vollständigen Verlauf.
- **Alle Chats durchsuchen:** Nutze die Suchschaltfläche in der Seitenleiste oder das plattformweite Tastenkürzel, um gespeicherte Chats zu durchsuchen.
- **Alle Chats:** Projekt-Badges kennzeichnen Projekt-Chats im seitenweise geladenen Verlauf. **Alle Chats** bietet außerdem eine serverseitige Suche und Bearbeitungsaktionen.
- **Chat-Kontext:** Auf Laptop- und Desktop-Bildschirmen bleibt die kompakte Kontextansicht oben rechts. Auf kleineren Bildschirmen öffnet die Schaltfläche **Kontext** unter dem Eingabefeld dieselbe Zusammenfassung in einem Dialog. Ein Projekt-Chat enthält seinen geerbten Projektkontext ohne Aktionen zur Projektbearbeitung.
- **Aktueller Dateikontext:** Hochgeladene und erzeugte Dateien werden direkt aktualisiert. Bilder öffnen sich in der Bildansicht, Dateien direkt im Dateibrowser. Projekt- und Chatdateien erscheinen in derselben Liste und behalten ihre Herkunft.
- **Cloud-Ressourcen:** Hänge über das Plus-Menü eine unterstützte Cloud-Ressource an, ohne ihren Inhalt in den Chat zu kopieren. Ein Chat, der aus Mail oder einer anderen Anwendung geöffnet wurde, kann bereits eine oder mehrere Ressourcen enthalten. Ressourcenlinks öffnen die zuständige Anwendung in einem neuen Tab. Jeder Lesezugriff und jede Aktion prüft weiterhin deine aktuelle Berechtigung in dieser Anwendung.
- **Quellen und Referenzen:** Eine Referenz zeigt den aktuellen Ressourcentitel und darunter den Ressourcentyp, wenn die zuständige Anwendung beides bereitstellt. Wähle eine Quelle oder Referenz aus, um ihr Ziel zu prüfen, bevor du es in einem neuen Tab öffnest.
- **Alle anzeigen:** Die kompakte Zusammenfassung zeigt pro Bereich bis zu drei Einträge. Über **Alle anzeigen** kannst du vollständige Wissens-, Quellen- und Referenzlisten durchsuchen, alle Dateien anzeigen, alle Bilder in der Bildansicht öffnen oder die geplanten Aufgaben des Chats verwalten.
Nach sieben Tagen ohne Nutzung erscheinen Chats automatisch unter **Fertig**. Öffnen und Lesen zählen als Nutzung; automatische Metadatenänderungen nicht. Laufende Chats und Chats, die auf eine Bestätigung warten, bleiben aktiv. **Chat wieder öffnen** hält einen Chat aktiv, bis du ihn erneut als fertig markierst. Die Sidebar zeigt alle aktiven Chats und direkt darunter **Fertig** mit dem Zugang zu **Alle Chats**.

- **Abschließen oder fortsetzen:** Markiere einen Chat als fertig, um ihn unter **Fertig** abzulegen. Stoppe vorher eine laufende Antwort. Öffne ihn wieder oder sende eine neue Nachricht; Dateien, Apps und Anheftung bleiben erhalten.
- **Bearbeiten oder archivieren:** Öffne die Chatvorschau und wähle **Chat-Einstellungen**, um Namen, Beschreibung, Anheftung oder Archivstatus zu ändern. Die Vorschau öffnet sich beim Darüberfahren, über das Info-Symbol auf Touch-Geräten oder per Tab-Taste.
:::

## Nachrichtenaktionen {icon="point"}

:::reference
- **Beenden:** Beendet die laufende Antwort des Assistenten im geöffneten Chat.
- **Erneut versuchen:** Führt eine Benutzernachricht erneut aus und ersetzt spätere Nachrichten dieses Chat-Zweigs.
- **Abzweigen:** Erstellt einen neuen Chat, der bis einschließlich der ausgewählten Nachricht kopiert wird.
- **Kontext kürzen:** Öffne die Kontextanzeige beim Eingabefeld und wähle **Kontext kürzen**, um den bisherigen Chat-Kontext zusammenzufassen. Alternativ kannst du `/compact` verwenden. Hover zeigt die Details; ein Klick hält sie offen. Escape oder ein Klick außerhalb schließt sie.
- **Projekte:** Die Projekteinstellungen zeigen gemeinsame Anweisungen und Kontext entsprechend deiner Lese-, Schreib- oder Administratorberechtigung. Projekt-Chats bleiben privat.
:::

:::info Freigaben und Client-Aktionen
Manche Anfragen benötigen eine Freigabe oder das Ergebnis eines Frontend-Tools. Beantworte diese Aufforderungen in der Nachrichtenliste, damit die Anfrage fortgesetzt werden kann. Begrenzte, wiederholbare Aktionen können im Menü der Freigabeschaltfläche **Immer freigeben** anbieten. Löschvorgänge, externe Auswirkungen und andere folgenreiche Aktionen erfordern weiterhin jedes Mal eine Freigabe.
:::

## Assistent mit Chat-Kontext {icon="message-forward"}

Der Assistent kann seine verfügbaren Capabilities verwenden, wenn deine Anfrage vom Chatverlauf abhängt. Er kann den aktuellen Chat durchsuchen, einen anderen eigenen Chat finden und lesen sowie strukturierte Cloud-Ressourcen suchen, die in einem der beiden Bereiche verwendet wurden.

Wenn du den Assistenten ausdrücklich bittest, einer anderen Unterhaltung einen genauen Text mitzuteilen, sie danach zu fragen, sie zu benachrichtigen oder Text weiterzuleiten oder zu senden, kann er die Aktion `core.ai.chat.message` anfordern. Vor dem Einreihen zeigt die Freigabeaufforderung das Ziel und den genauen Text. Zugestellte Nachrichten erscheinen mit ihrem Quell-Chat im Zielverlauf. Sie werden nicht als von dir verfasste Nachrichten dargestellt.

## Audio und Diktieren {icon="microphone"}

Hänge eine Sprachmemo wie jede andere Datei an und schreibe deinen Auftrag
selbst dazu, zum Beispiel: „Transkribiere diese Aufnahme und fasse die nächsten
Schritte zusammen.“ Das Anhängen allein startet keine Transkription. Der
Assistent kann das Transkript als Textdatei im Chat speichern.

Mit **Diktieren** sprichst du deinen Prompt ein. Die neutrale Wellenform zeigt
deinen Mikrofonpegel. Mit × verwirfst du die Aufnahme; die quadratische Stopptaste
beendet sie. **Aufnahme stoppen** lädt die
vollständige Aufnahme hoch. Ist dein Eingabefeld unverändert geblieben, wird
der erkannte Text dort ergänzt. Ansonsten erscheint **Diktat bereit** mit
**Einfügen** und **Verwerfen**. Du prüfst den Text und sendest ihn selbst.

Nach bestätigtem Upload bleibt das Diktat im zugehörigen Chat verfügbar, auch
wenn du den Chat wechselst oder die Seite neu lädst. Vorher kann ein Reload
oder das Schließen des Tabs die Aufnahme verlieren. Bei einem Uploadfehler
kannst du die noch vorhandene Aufnahme erneut hochladen. Bei einem Fehler der
Transkription kannst du sie wiederholen oder verwerfen.

Wurde der gespeicherte Entwurf in einer anderen Sitzung geändert, bleibt dein
lokaler Text erhalten. Prüfe den angezeigten gespeicherten Entwurf und wähle,
welchen Stand du übernehmen möchtest.

Diktieren benötigt eine Mikrofonberechtigung, einen unterstützten Browser und
ein freigegebenes Audio-Modell. Die Aufnahme wird als WAV gespeichert.
Transkriptionen akzeptieren höchstens 25 MB; weitere Dateiformate hängen vom
konfigurierten Provider ab. Es gibt keine automatische Formatkonvertierung.

Nach dem Stoppen erscheint bis zum Abschluss eine Ladeanzeige. Bei Hover oder Tastaturfokus wird daraus ein
Papierkorb zum Verwerfen. Auf Touch-Geräten kannst du den Button direkt antippen.
Eine bereits hochgeladene Audiodatei bleibt dabei im Chat.

Fehlerhinweise bleiben als Benachrichtigung sichtbar, bis du sie schließt.
„Erneut versuchen“ wiederholt den fehlgeschlagenen Schritt. Das Schließen
verwirft die Aufnahme nicht: Am Icon bleiben „Erneut versuchen“ und „Verwerfen“
erreichbar.

## Slash-Befehle und Kontext auswählen

Tippe `/` an einer Wortgrenze im Eingabefeld, auch mitten im Text. Suche nach
einem Namen oder grenze mit `/skill`, `/app`, `/file` oder `/project` ein.
Pfeiltasten und Enter oder Tab wählen einen Treffer aus; Escape schließt die
Vorschläge und erhält deinen Entwurf. Die Vorschläge ersetzen vorübergehend
die Aufgabenanzeige über dem Eingabefeld.

`/compact` kompaktiert den Chat, `/fork` zweigt ihn nach der letzten Antwort ab
und `/new` öffnet einen neuen Chat. Skills, Apps und Dateien erscheinen als
hervorgehobene Referenzen. Ausgewählte Skills werden für die nächste Antwort
geladen. Eine App-Erwähnung führt noch keine Aktion aus.

Ein Projekt kannst du einem Chat ohne Projekt einmalig dauerhaft zuordnen.
Danach gelten seine Anweisungen und Dateien für neue Antworten; Projekt-Treffer
verschwinden aus dem Slash-Menü. Laufende oder wartende Nachrichten müssen
vorher abgeschlossen sein.

## Chats durchsuchen

**Alle Chats durchsuchen** öffnet die globale Suche für Titel und Nachrichteninhalte
deiner Assistant-Chats. **Diesen Chat durchsuchen** begrenzt sie auf Nachrichten im
geöffneten Chat. Der entfernbare Filter zeigt den Suchbereich. Eine Suchaktion
in der Palette setzt ihn direkt im offenen Fenster. Entfernst du den Filter,
suchst du wieder in allen Cloud-Apps.

Nachrichtentreffer springen zur passenden Stelle im Chat. Mit Cmd/Strg+Enter
öffnest du einen Treffer in einem neuen Tab.
