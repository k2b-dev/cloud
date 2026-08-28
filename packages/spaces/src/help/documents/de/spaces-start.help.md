---
id: spaces-start
title: Überblick
icon: ti ti-layout-sidebar
description: Grundbegriffe und die ersten Schritte mit einem Space.
order: 100
---

Spaces bündelt gemeinsame Arbeit mit Aufgaben, Terminen, Listen, zuständigen Personen, Kommentaren und einfacher Planung. Die Spaces-Übersicht zeigt alle Arbeitsbereiche, auf die du zugreifen kannst. Dort kannst du einen Space erstellen, suchen oder erneut öffnen.

## Grundbegriffe {icon="layout-grid"}

:::reference
- **Space:** Ein Arbeitsbereich für ein Team, Projekt, einen Haushalt, Kurs oder wiederkehrenden Ablauf.
- **Eintrag:** Die grundlegende Arbeitseinheit. Ein Eintrag ist entweder eine Aufgabe mit Fälligkeitsdatum oder ein Termin mit festgelegter Zeit.
- **Aufgabe:** Arbeit mit Status, Priorität, zuständigen Personen, Fälligkeitsdatum, geschätzter Dauer, Abhängigkeiten, Tags, Beschreibung und Kommentaren.
- **Termin:** Ein zeitlich geplanter Eintrag, der in Kalenderansichten und optionalen Kalenderexporten erscheint.
- **Ansicht:** Die aktuelle Darstellung derselben Einträge als Liste, Tabelle, Kanban-Board oder Kalender.
- **Tags:** Kurze Kennzeichnungen, mit denen sich Arbeit unabhängig von Zuständigkeiten, Fälligkeitsdaten, Terminen und Ansichten gruppieren lässt.
:::

## Einen Space sinnvoll einrichten {icon="route"}

:::steps
1. **Space erstellen:** Benenne ihn nach dem gemeinsamen Arbeitsbereich und nicht nach einer einzelnen Aufgabe, zum Beispiel Produktstart, Büroumzug oder Wochenplanung.
2. **Echte Einträge hinzufügen:** Erstelle einige Aufgaben oder Termine, bevor du Ansichten anpasst. Anhand der tatsächlichen Arbeit wird deutlich, welche Status, Tags und zuständigen Personen benötigt werden.
3. **Ansichten wählen:** Nutze eine Liste oder Tabelle für den Überblick, Kanban für den Arbeitsfortschritt und den Kalender für zeitlich geplante Arbeit.
4. **Mit den passenden Personen teilen:** Lade Personen oder Gruppen ein, sobald die Struktur klar genug ist, damit sie ohne zusätzliche Erklärung mitarbeiten können.
:::

:::note Wann Spaces passt
Verwende Spaces, wenn Personen eine übersichtliche gemeinsame Arbeitsfläche benötigen. Verwende Grids, wenn Datensätze typisierte Felder, Beziehungen, Formulare, Dashboards, Formeln, Exporte oder Automatisierungen benötigen.
:::

## Spaces mit Einladungen aus Mail verwenden {icon="calendar-share"}

Spaces verwaltet den importierten Terminstatus, Wiederholungen, organisierende und teilnehmende Personen sowie die Sequenznummern der Einladung. Mail verwaltet die ursprüngliche Nachricht, Postfachidentitäten, bearbeitbare Entwürfe, Anhänge und den Versand. Dadurch liegt jeder Termin in genau einem Kalender, während Einladungen weiterhin über den normalen Versandablauf von Mail versendet werden.

- Importiere eine Einladung ausdrücklich aus Mail. Wenn du in Mail antwortest, wird der Termin gespeichert oder aktualisiert und zugleich ein bearbeitbarer Antwortentwurf vorbereitet.
- Eine erneut zugestellte Einladung mit derselben Kalender-UID aktualisiert den verknüpften Termin nur, wenn ihre Sequenznummer höher ist. Veraltete oder doppelte Zustellungen erzeugen keinen weiteren Termin.
- Eine Absage schließt den verknüpften Termin ab. Sie kann allein keinen neuen Termin erstellen.
- Öffne in einem bearbeitbaren Termin **Einladungen**. Wähle ein beschreibbares Postfach und eine aktuell bestätigte Absenderidentität, bevor du einen bearbeitbaren Entwurf in Mail erstellst. Aktualisierungen verwenden eine höhere Sequenznummer, Absagen müssen ausdrücklich ausgelöst werden und Versandfehler bleiben in Spaces sichtbar.
- Wenn Mail oder die benötigte Capability nicht verfügbar ist, bleiben die Einladungsfunktionen ausgeblendet. Spaces kann weiterhin vollständig als Kalender verwendet werden.
- Wähle in einem Mail-Entwurf einen vorhandenen Termin oder erstelle einen kompakten Termin in einem beschreibbaren Space. Hänge anschließend die Einladung an. Der Entwurf bleibt bearbeitbar und wird nur über den normalen Versandablauf von Mail gesendet.

## Cloud-Ressourcen mit Arbeit verknüpfen {icon="link"}

Ein Eintrag kann dauerhafte Verweise auf Ressourcen anderer Cloud-Anwendungen enthalten. Wähle beim Bearbeiten unter **Verknüpfte Ressourcen** die Aktion **Cloud-Ressource verknüpfen**. Damit kannst du über die Cloud-Suche unterstützte Ressourcen finden und anhängen, auf die du aktuell zugreifen darfst. Mail verwendet dasselbe Modell, um eine gesamte Unterhaltung mit einer bestehenden Aufgabe oder einem Termin zu verknüpfen oder daraus einen neuen verknüpften Eintrag zu erstellen. Importierte Kalendereinladungen fügen denselben Verweis auf die Unterhaltung automatisch hinzu.

Der Verweis gehört zum gemeinsamen Eintrag und nicht zu der Person, die ihn erstellt hat. Der Zugriff auf den Space bestimmt, wer den Verweis sehen oder entfernen darf. Beim Öffnen prüft die Zielanwendung zusätzlich die aktuelle Berechtigung für ihre Ressource. Wenn das Ziel gelöscht oder der Zugriff geändert wurde, bleibt die gespeicherte Bezeichnung für Personen mit Lesezugriff sichtbar. Eine Person mit Schreibzugriff kann den nicht mehr verfügbaren Verweis entfernen.

Verknüpfungen zu anderen Aufgaben erscheinen getrennt unter **Verwandte Aufgaben**. Sie liefern nur zusätzlichen Kontext und blockieren keine der beiden Aufgaben. Eine Verknüpfung darf auf eine Aufgabe in einem anderen Space zeigen, wenn auf beide Einträge zugegriffen werden kann.
