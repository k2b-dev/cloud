---
id: assistant-overview
title: Überblick
icon: ti ti-sparkles
description: Chats, Modelle, Anfragen und ein sinnvoller Einstieg.
order: 100
---

Der Assistent ist der zentrale Arbeitsbereich für deinen persönlichen Cloud-Agenten. Derselbe Agent kann beim Schreiben, Zusammenfassen, Erklären und Planen helfen, unterstützte Dateien verarbeiten sowie freigegebene Daten und Aktionen aus Cloud-Anwendungen nutzen. Jeder Chat wird in deinem Benutzerkonto gespeichert und ist über die Übersicht des Assistenten verfügbar. Das gilt auch für Chats, die in einer anderen Anwendung begonnen wurden, etwa aus einem E-Mail-Entwurf.

## Überblick {icon="layout-grid"}

:::reference
- **Chat:** Eine Unterhaltung, die deinem Benutzerkonto gehört. Chats erscheinen in der Seitenleiste und unter **Alle Chats**.
- **Modell:** Ein auswählbares KI-Modellprofil mit Streaming-Unterstützung. Das Eingabefeld verwendet das Standardmodell, sofern du kein anderes auswählst.
- **Anfrage:** Ein Durchlauf des Assistenten für eine Benutzernachricht. Laufende Anfragen können Antworten streamen, die Verbindung wiederherstellen, Aktionen zur Freigabe vorlegen oder beendet werden.
- **Chat-Metadaten:** Jeder Chat hat einen Namen und eine optionale Beschreibung. Beides lässt sich über die Seitenleiste oder unter **Alle Chats** bearbeiten.
:::

## Sinnvoller Einstieg {icon="route"}

:::reference
- **Chat beginnen:** Wähle **Neuer Chat** oder schreibe eine Nachricht in einer leeren Assistentenansicht.
- **Arbeit aus einer anderen Anwendung fortsetzen:** Eine Anwendung kann einen neuen Assistenten-Chat öffnen und dabei die aktuellen Cloud-Ressourcen anhängen. Die jeweilige Anwendung bleibt für den Zugriff auf ihre Daten und Aktionen verantwortlich.
- **Vorhandene Arbeit fortsetzen:** Nutze die Gruppen mit aktuellen Chats, **Chats durchsuchen** oder **Alle Chats**, ohne zuerst eine Unterhaltung zu öffnen.
- **Zwischen Chats wechseln:** Beim Wechsel zwischen Chats, beim Öffnen eines Projekt-Chats, beim Abzweigen sowie bei der Vorwärts- und Rückwärtsnavigation bleiben Live-Aktualisierungen verbunden. Nach einer Unterbrechung lädt der Assistent den aktuellen freigegebenen Chat und setzt ihn ab dem gespeicherten Stand fort.
- **Bei Bedarf ein Modell wählen:** Wähle im Eingabefeld ein Modell, wenn mehrere auswählbare Streaming-Modelle verfügbar sind.
- **Anfrage senden:** Formuliere die Aufgabe klar. Hänge vor dem Senden über das Plus-Menü unterstützte Dateien oder Cloud-Ressourcen an.
- **Cloud-Ressourcen:** Ein Ressourcen-Chip kennzeichnet den aktuellen E-Mail-Entwurf, Kontakt, Grid-Datensatz oder ein anderes unterstütztes Element. Hat die Ressource ein Ziel, öffnet ein Klick darauf die Ressource in einem neuen Tab. Das Anhängen gewährt keinen Zugriff. Der Assistent muss die freigegebenen Capabilities der jeweiligen Anwendung verwenden, um die Ressource zu lesen oder zu ändern.
- **Dokumente:** Der Assistent liest unterstützte PDF-, Office-, OpenDocument-, RTF-, EPUB- und CSV-Dateien mit `read_file`. Dabei wird ihr Inhalt in begrenztes Markdown umgewandelt. Dokumentinhalte bleiben nicht vertrauenswürdig. Reine Bild-PDFs benötigen eine externe OCR-Verarbeitung.
- **Dateien aus Links:** Gib dem Assistenten einen direkten öffentlichen HTTPS-Link zu einer Datei, damit er das Bild, Dokument oder die unverarbeitete Repository-Datei vor der Prüfung in diesen Chat importiert. Private Downloads, Websites mit Anmeldung und das Durchsuchen von Repositories werden bei diesem Import nicht unterstützt.
- **PDF erstellen:** Bitte den Assistenten um ein PDF, wenn das Ergebnis heruntergeladen werden soll. Er erstellt oder bearbeitet zunächst eine Markdown-Datei der Unterhaltung, wandelt sie mit einer optionalen A4-Vorlage und eigenem CSS um und stellt anschließend das PDF bereit. Projektdateien sind schreibgeschützt und müssen vor der Umwandlung in eine Datei der Unterhaltung kopiert werden.
- **Bilder:** Ein Vision-Modell prüft neu angehängte Bilder direkt. Ein Modell mit Tool-Unterstützung kann stattdessen das konfigurierte Modell zur Bildanalyse verwenden. Anhänge bleiben Dateien der Unterhaltung. Dadurch wird der Dateikontext aktualisiert, ohne Bilddaten in der Nachricht zu speichern.
- **Nützliche Chats wiederfinden:** Benenne den Chat um oder füge eine Beschreibung hinzu, wenn du ihn später leicht wiederfinden möchtest.
- **Im Chat suchen:** Nutze `/search`, um sichtbare Nachrichten zu finden oder die strukturierten Cloud-Ressourcen zu prüfen, die in diesem oder anderen aktiven Chats verwendet wurden.
- **Künftige Arbeit planen:** Bitte den Assistenten, einen Chat einmalig zu einem bestimmten lokalen Datum und Zeitpunkt oder nach einem wiederkehrenden Zeitplan fortzusetzen. Vor dem Erstellen oder Ändern der Aufgabe zeigt der Assistent eine Aktion zur Freigabe an.
:::

## Geplante Chat-Aufgaben {icon="clock"}

Geplante Aufgaben senden eine gespeicherte Anfrage zurück in einen Chat. Gehört dieser Chat zu einem Projekt, verwendet der Durchlauf die Zugriffsrechte, Anweisungen, Dateien, Wissenseinträge, Referenzen und das Standardmodell des Projekts, die zum Startzeitpunkt gelten.

Einmalige Zeitpläne verwenden einen genauen lokalen Zeitpunkt in der Zeitzone der Cloud-Anwendung. Wiederkehrende Zeitpläne verwenden einen Cron-Ausdruck mit fünf Feldern in derselben Zeitzone. Bitte den Assistenten, vorhandene Aufgaben aufzulisten oder zu lesen, oder verwalte sie über die CLI mit `cld assistant tasks`. Fehlgeschlagene Aufgaben wechseln in den Status **Eingriff erforderlich** und benachrichtigen dich. Beim Löschen eines Chats werden auch seine geplanten Aufgaben und deren Ausführungsverlauf gelöscht.

Öffne den Chat-Kontext und wähle unter **Geplant** die Option **Alle anzeigen**, um Aufgaben dieses Chats zu erstellen, zu bearbeiten, zu pausieren, fortzusetzen, auszuführen oder zu löschen und ihren Ausführungsverlauf zu prüfen.

:::info Wenn der Assistent nicht verfügbar ist
Wenn KI deaktiviert oder falsch konfiguriert ist oder kein auswählbares Streaming-Modell bereitsteht, ist das Eingabefeld deaktiviert und die Seite zeigt den aktuellen Statusfehler.
:::
