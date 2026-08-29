---
id: assistant-guidance
title: Bessere Ergebnisse
icon: ti ti-bulb
description: Nützlichen Kontext geben, mit Dateien arbeiten, Antworten personalisieren und fehlgeschlagene Anfragen fortsetzen.
order: 120
---

Der Assistent erzielt die besten Ergebnisse, wenn deine Anfrage das gewünschte Ergebnis, den relevanten Kontext und wichtige Grenzen nennt. Ein besonderes Prompt-Format ist nicht erforderlich.

## Eine hilfreiche Anfrage formulieren {icon="pencil"}

:::steps
1. **Ergebnis benennen:** Beschreibe, was du erhalten möchtest, etwa eine Zusammenfassung, einen Plan, eine Erklärung, einen Entwurf, einen Vergleich oder eine Codeänderung.
2. **Ausgangsmaterial angeben:** Füge den relevanten Text ein oder hänge die im Eingabefeld angebotenen Dateien an. Nenne die Stellen, auf die es besonders ankommt.
3. **Wichtige Vorgaben nennen:** Gib Zielgruppe, Sprache, Länge, Format, Frist oder unveränderliche Inhalte an.
4. **Um Prüfung bitten:** Bitte den Assistenten bei wichtigen Ergebnissen, Annahmen, Unsicherheiten oder fehlende Informationen zu benennen, bevor du dich auf die Antwort verlässt.
:::

## Kontext gezielt verwenden {icon="point"}

- **Denselben Chat fortsetzen**, wenn die nächste Anfrage von früheren Nachrichten abhängt.
- **Einen neuen Chat beginnen**, wenn die Aufgabe nicht dazugehört oder der bisherige Kontext irreführend sein könnte.
- **Von einer Nachricht abzweigen**, wenn du eine andere Richtung verfolgen möchtest, ohne den nützlichen Zweig zu ersetzen.
- **`/compact` verwenden**, wenn ein langer Chat mit einer kürzeren Zusammenfassung seines Kontexts fortgesetzt werden soll.
- **Eine Chatbeschreibung hinzufügen**, wenn später erkennbar sein soll, warum die Unterhaltung wichtig ist.

## Personalisierung {icon="point"}

- **Personalisierung** speichert Tatsachen, Präferenzen und Standards für Cloud-Abläufe, die du prüfen, bearbeiten, anheften oder vergessen kannst. Manuell hinzugefügte Einträge sind zunächst angeheftet. Der Assistent verwendet eine kleine relevante Auswahl im Kontext, statt einen unbegrenzten Verlauf zu laden.
- **Aus Chats lernen** prüft jede neu abgeschlossene Anfrage eines privaten Chats einmal. Ausdrückliche Angaben von dir können dauerhafte Tatsachen und Präferenzen aktualisieren. Drei erfolgreiche Verwendungen derselben Cloud-Capability und Ressource können einen Standardablauf begründen. Anhänge und unverarbeitete Tool-Ausgaben sind ausgeschlossen; die abschließende Antwort des Assistenten dient nur als Kontext. Beim Lernen im Hintergrund dürfen nur eigene, nicht angeheftete Einträge zusammengeführt, ersetzt oder entfernt werden.
- **System-Prompt** zeigt den vollständigen Prompt für einen neuen Chat einschließlich aktiver Personalisierung und Organisationsregeln.
- **Freigaben** listet Aktionen auf, die du mit **Immer freigeben** angenommen hast. Widerrufe dort einen Eintrag, sobald der Assistent wieder nachfragen soll.
- **Chat-Kontext** eignet sich weiterhin am besten für projektspezifische Tatsachen, Ausgangsmaterial und einmalige Vorgaben.

## Geteilte Skills {icon="sparkles"}

Öffne **Assistent-Einstellungen > Skills**, um wiederverwendbare Abläufe des Assistenten zu erstellen, zu importieren, zu bearbeiten, zu exportieren oder zu teilen. Ein Skill speichert seine Anweisungen in `SKILL.md` und kann Markdown-Referenzdateien enthalten.

Du kannst den Assistenten auch bitten, einen Skill zu erstellen oder zu verbessern. Cloud stellt allen angemeldeten Personen zunächst **Skill Creator** bereit. Dieser Skill führt durch den Entwurf und verwendet geprüfte Capabilities zur Skill-Verwaltung mit deinen aktuellen Berechtigungen. Wie jeder geteilte Skill lässt er sich für dich deaktivieren. Personen mit Administratorrechten können Zugriff vergeben, den Skill bearbeiten oder ihn löschen.

### Einen Skill passend laden lassen

:::steps
1. **Kurzen, handlungsorientierten Namen wählen:** Verwende Kleinbuchstaben, Zahlen und Bindestriche, etwa `weekly-status`.
2. **Direkte Beschreibung schreiben:** Beschreibe, was der Assistent tun und wann er den Skill verwenden soll. Formuliere so konkret, dass er sich von ähnlichen Abläufen unterscheidet. Beispiel: `Erstelle wöchentliche Statusberichte aus den letzten Arbeiten. Verwende diesen Skill bei Anfragen nach Fortschrittsberichten.`
3. **Nur nützliche Anweisungen hinzufügen:** Lege das erwartete Ergebnis, wichtige Vorgaben und den Ablauf fest. Verzichte auf allgemeine Hinweise, die der Assistent bereits kennt.
4. **Ergänzende Details unter Zusatzinformationen ablegen:** Füge dort Richtlinien, Schemas, Beispiele oder Hintergrundinformationen ein, die der Assistent nur bei manchen Anfragen benötigt. Wesentliche Anweisungen bleiben im Skill selbst.
5. **Mit realistischen Anfragen testen:** Prüfe, ob der Assistent den Skill bei passenden Anfragen lädt und ihn andernfalls ignoriert. Präzisiere die Beschreibung, wenn der Skill zu oft oder zu selten ausgewählt wird.
:::

- Importiere eine einzelne `SKILL.md` oder verwende eine ZIP-Datei, wenn der Skill Referenzen enthält. Skripte und Assets werden nicht unterstützt.
- Teile einen Skill über die Cloud-Zugriffsverwaltung. Personen mit Lesezugriff können ihn verwenden und exportieren, Personen mit Schreibzugriff können ihn bearbeiten und Personen mit Administratorrechten können außerdem den Zugriff verwalten oder den Skill löschen.
- Skills, die du lesen kannst, sind zunächst für dich aktiviert. Deaktiviere **Für mich aktiviert**, wenn der Assistent einen geteilten Skill nicht verwenden soll. Das ändert den Zugriff anderer Personen nicht.
- Der Assistent sieht Namen und Beschreibungen deiner aktivierten Skills. Er lädt einen passenden Skill, bevor er dessen Anweisungen anwendet, und liest Referenzen nur bei Bedarf.
- Ein für eine laufende Anfrage geladener Skill bleibt bei seiner aktuellen Revision. Neue Anfragen verwenden spätere Änderungen. Ein widerrufener Zugriff gilt sofort.

:::warning Folgenreiche Ergebnisse prüfen
Behandle erzeugte Tatsachen, Berechnungen, externe Aktionen und Änderungen an wichtigen Daten als Vorschläge, bis du sie geprüft hast. Freigabeaufforderungen ermöglichen diese Prüfung, bevor die Anfrage fortgesetzt wird.
:::

## Wenn eine Antwort stockt oder die Aufgabe verfehlt {icon="point"}

- Beende eine Anfrage, die klar in die falsche Richtung läuft, und sende anschließend eine kürzere Korrektur.
- Versuche es erneut, wenn die Anfrage sinnvoll war, aber die Ausführung fehlgeschlagen ist oder nur ein unvollständiges Ergebnis geliefert hat.
- Prüfe das ausgewählte Modell und den Status am Eingabefeld, wenn keine Antwort beginnt.
- Teile eine große Anfrage in ein kleines erstes Ergebnis und eine Folgeanfrage auf, statt einen überladenen Prompt zu wiederholen.
