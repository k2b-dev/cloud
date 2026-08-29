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
- **Chats durchsuchen:** Nutze die Suchschaltfläche in der Seitenleiste oder das plattformweite Tastenkürzel, um gespeicherte Chats zu durchsuchen.
- **Alle Chats:** Projekt-Badges kennzeichnen Projekt-Chats im seitenweise geladenen Verlauf. **Alle Chats** bietet außerdem eine serverseitige Suche und Bearbeitungsaktionen.
- **Chat-Kontext:** Auf Laptop- und Desktop-Bildschirmen bleibt die kompakte Kontextansicht oben rechts. Auf kleineren Bildschirmen öffnet die Schaltfläche **Kontext** unter dem Eingabefeld dieselbe Zusammenfassung in einem Dialog. Ein Projekt-Chat enthält seinen geerbten Projektkontext ohne Aktionen zur Projektbearbeitung.
- **Aktueller Dateikontext:** Hochgeladene und erzeugte Dateien werden direkt aktualisiert. Bilder öffnen sich in der Bildansicht, Dateien direkt im Dateibrowser. Projekt- und Chatdateien erscheinen in derselben Liste und behalten ihre Herkunft.
- **Cloud-Ressourcen:** Hänge über das Plus-Menü eine unterstützte Cloud-Ressource an, ohne ihren Inhalt in den Chat zu kopieren. Ein Chat, der aus Mail oder einer anderen Anwendung geöffnet wurde, kann bereits eine oder mehrere Ressourcen enthalten. Ressourcenlinks öffnen die zuständige Anwendung in einem neuen Tab. Jeder Lesezugriff und jede Aktion prüft weiterhin deine aktuelle Berechtigung in dieser Anwendung.
- **Quellen und Referenzen:** Eine Referenz zeigt den aktuellen Ressourcentitel und darunter den Ressourcentyp, wenn die zuständige Anwendung beides bereitstellt. Wähle eine Quelle oder Referenz aus, um ihr Ziel zu prüfen, bevor du es in einem neuen Tab öffnest.
- **Alle anzeigen:** Die kompakte Zusammenfassung zeigt pro Bereich bis zu drei Einträge. Über **Alle anzeigen** kannst du vollständige Wissens-, Quellen- und Referenzlisten durchsuchen, alle Dateien anzeigen, alle Bilder in der Bildansicht öffnen oder die geplanten Aufgaben des Chats verwalten.
- **Bearbeiten oder archivieren:** Über die Einstellungen eines Chats kannst du seinen Namen, seine Beschreibung, die Anheftung oder den Archivstatus ändern.
:::

## Nachrichtenaktionen {icon="point"}

:::reference
- **Beenden:** Beendet die laufende Antwort des Assistenten im geöffneten Chat.
- **Erneut versuchen:** Führt eine Benutzernachricht erneut aus und ersetzt spätere Nachrichten dieses Chat-Zweigs.
- **Abzweigen:** Erstellt einen neuen Chat, der bis einschließlich der ausgewählten Nachricht kopiert wird.
- **Komprimieren:** Nutze `/compact`, um den aktuellen Chat-Kontext vor dem Fortsetzen zusammenzufassen.
- **Projekte:** Die Projekteinstellungen zeigen gemeinsame Anweisungen und Kontext entsprechend deiner Lese-, Schreib- oder Administratorberechtigung. Projekt-Chats bleiben privat.
:::

:::info Freigaben und Client-Aktionen
Manche Anfragen benötigen eine Freigabe oder das Ergebnis eines Frontend-Tools. Beantworte diese Aufforderungen in der Nachrichtenliste, damit die Anfrage fortgesetzt werden kann. Begrenzte, wiederholbare Aktionen können im Menü der Freigabeschaltfläche **Immer freigeben** anbieten. Löschvorgänge, externe Auswirkungen und andere folgenreiche Aktionen erfordern weiterhin jedes Mal eine Freigabe.
:::

## Assistent mit Chat-Kontext {icon="message-forward"}

Der Assistent kann seine verfügbaren Capabilities verwenden, wenn deine Anfrage vom Chatverlauf abhängt. Er kann den aktuellen Chat durchsuchen, einen anderen eigenen Chat finden und lesen sowie strukturierte Cloud-Ressourcen suchen, die in einem der beiden Bereiche verwendet wurden.

Wenn du den Assistenten ausdrücklich bittest, einer anderen Unterhaltung einen genauen Text mitzuteilen, sie danach zu fragen, sie zu benachrichtigen oder Text weiterzuleiten oder zu senden, kann er die Aktion `core.ai.chat.message` anfordern. Vor dem Einreihen zeigt die Freigabeaufforderung das Ziel und den genauen Text. Zugestellte Nachrichten erscheinen mit ihrem Quell-Chat im Zielverlauf. Sie werden nicht als von dir verfasste Nachrichten dargestellt.
