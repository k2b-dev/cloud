---
id: spaces-start
title: Mit Spaces beginnen
icon: ti ti-layout-sidebar
description: Lerne die Grundbegriffe kennen, richte einen Space ein und verbinde ihn mit Einladungen aus Mail und anderen Ressourcen.
order: 100
---

Spaces bündelt gemeinsame Arbeit mit Aufgaben, Terminen, Listen, zuständigen Personen, Kommentaren und einfacher Planung. Die Spaces-Übersicht zeigt alle Spaces, auf die du zugreifen kannst. Dort erstellst, suchst oder öffnest du einen Space.

Öffnest du Spaces über die Navigation, landest du im Space, den du in diesem Browser zuletzt angesehen hast, auch wenn das in einem anderen Tab war. Wurde er gelöscht oder nicht mehr mit dir geteilt, öffnet sich stattdessen die Übersicht.

## Grundbegriffe kennen {icon="layout-grid"}

:::reference
- **Space:** Ein Arbeitsbereich für ein Team, ein Projekt, einen Haushalt, einen Kurs oder einen wiederkehrenden Ablauf.
- **Eintrag:** Die grundlegende Arbeitseinheit. Ein Eintrag ist entweder eine Aufgabe mit Fälligkeitsdatum oder ein Termin mit festgelegter Zeit.
- **Aufgabe:** Arbeit mit Status, Priorität, zuständigen Personen, Fälligkeitsdatum, geschätzter Dauer, Abhängigkeiten, einer einfachen Checkliste, Tags, Beschreibung und Kommentaren.
- **Termin:** Ein zeitlich geplanter Eintrag. Termine erscheinen in Kalenderansichten und in optionalen Kalenderexporten.
- **Ansicht:** Die aktuelle Darstellung derselben Einträge: **Übersicht**, **Tabelle**, **Kanban** oder **Kalender**.
- **Tags:** Kurze Kennzeichnungen, die Arbeit unabhängig von Zuständigkeiten, Fälligkeitsdaten, Terminen und Ansichten gruppieren.
:::

## Space einrichten {icon="route"}

:::steps
1. **Space erstellen:** Benenne ihn nach dem gemeinsamen Arbeitsbereich, nicht nach einer einzelnen Aufgabe. Beispiele: Produktstart, Büroumzug, Wochenplanung.
2. **Echte Einträge hinzufügen:** Erstelle einige Aufgaben oder Termine, bevor du Ansichten anpasst. Echte Arbeit zeigt, welche Status, Tags und zuständigen Personen wichtig sind.
3. **Ansichten wählen:** Nutze **Übersicht** oder **Tabelle**, um Einträge zu überfliegen, **Kanban** für den Statusverlauf und **Kalender** für geplante Arbeit.
4. **Space teilen:** Lade Personen und Gruppen ein, sobald die Struktur klar ist. Dann arbeiten sie ohne zusätzliche Erklärung mit.
:::

:::note Wann Spaces passt
Nutze Spaces, wenn Personen einen übersichtlichen gemeinsamen Ort für ihre Arbeit brauchen. Nutze Grids, wenn Datensätze typisierte Felder, Beziehungen, Formulare, Dashboards, Formeln, Exporte oder Automatisierungen brauchen.
:::

## Spaces mit Einladungen aus Mail nutzen {icon="calendar-share"}

Spaces ist zuständig für den importierten Terminstatus, Wiederholungen, organisierende und teilnehmende Personen sowie die Sequenznummern der Einladung. Mail ist zuständig für die ursprüngliche Nachricht, Postfachidentitäten, bearbeitbare Entwürfe, Anhänge und den Versand. So liegt jeder Termin in genau einem Kalender, und Einladungen gehen weiter über den normalen Versand von Mail.

- Importiere eine Einladung ausdrücklich aus Mail. Oder antworte in Mail: Das speichert oder aktualisiert den Termin und bereitet in einem Schritt einen bearbeitbaren Antwortentwurf vor.
- Eine erneut zugestellte Einladung mit derselben Kalender-UID aktualisiert den verknüpften Termin nur, wenn ihre Sequenznummer höher ist. Veraltete oder doppelte Zustellungen erzeugen keinen weiteren Termin.
- Eine Absage schließt den verknüpften Termin ab. Eine Absage allein kann keinen neuen Termin erstellen.
- Öffne in einem bearbeitbaren Termin **Einladungen**. Wähle ein beschreibbares Postfach und eine aktuell bestätigte Absenderidentität. Erstelle dann einen bearbeitbaren Entwurf in Mail.
- Aktualisierungen verwenden eine höhere Sequenznummer. Eine Absage löst du ausdrücklich aus. Versandfehler bleiben in Spaces sichtbar.
- Ist Mail oder die Capability, die Spaces braucht, nicht verfügbar, blendet Spaces die Einladungsfunktionen aus. Du kannst Spaces weiter vollständig als Kalender nutzen.
- Wähle in einem Mail-Entwurf einen vorhandenen Termin oder erstelle einen kompakten Termin in einem beschreibbaren Space. Hänge dann seine Einladung an. Der Entwurf bleibt bearbeitbar, und Mail sendet ihn nur über den normalen Versand.

## Ressourcen und Seiten mit Arbeit verknüpfen {icon="link"}

Jeder Eintrag hat eine Liste **Links & Ressourcen** für Cloud-Ressourcen und externe Seiten. In einem bearbeitbaren Eintrag hast du zwei Möglichkeiten:

- Wähle **Link hinzufügen**, um eine `http(s)`-URL mit optionaler Bezeichnung anzuhängen. Ein Eintrag fasst bis zu 20 externe Links.
- Wähle **Cloud-Ressource verknüpfen**, um eine Ressource über die Cloud-Suche zu finden und anzuhängen. Du kannst jede unterstützte Ressource anhängen, auf die du aktuell zugreifen kannst.

Ein Link auf ein GitHub-Issue oder einen Pull Request zeigt `Repository#Nummer`, den Titel und ob er offen, geschlossen oder gemergt ist. Andere Links zeigen das Symbol und den Host der Seite oder die Bezeichnung, die du vergeben hast. Vorschauen sind schreibgeschützt. Sie aktualisieren sich wenige Minuten nach einer Änderung auf GitHub. Spaces schreibt nie nach GitHub.

Öffentliche Repositories brauchen keine Einrichtung. Für private Repositories kann eine Person mit Zugriff **Verwalten** unter **Space-Einstellungen → GitHub** ein GitHub-Token hinterlegen. Ohne Token erscheinen private Links als einfache Links. Verknüpfe eine Aufgabe mit ihrem Issue, statt das Issue in der Beschreibung zu wiederholen.

Ein Eintrag kann dauerhafte Verweise auf Ressourcen enthalten, die anderen Cloud-Apps gehören. Mail nutzt dasselbe Modell, um eine ganze Unterhaltung mit einer bestehenden Aufgabe oder einem Termin zu verknüpfen. Mail kann aus den Details der Unterhaltung auch einen verknüpften Eintrag erstellen. Importierte Kalendereinladungen fügen denselben Verweis auf die Unterhaltung automatisch hinzu.

Der Verweis gehört zum gemeinsamen Eintrag, nicht zu der Person, die ihn erstellt hat. Der Zugriff auf den Space bestimmt, wer den Verweis sehen oder entfernen kann. Beim Öffnen prüft die Ziel-App zusätzlich den aktuellen Zugriff auf ihre Ressource. Wird das Ziel entfernt oder ändert sich der Zugriff, sehen alle, die den Space sehen, weiter die gespeicherte Bezeichnung. Mit Zugriff **Bearbeiten** kannst du den nicht mehr verfügbaren Verweis entfernen.

Verknüpfungen zu anderen Aufgaben erscheinen getrennt unter **Verwandte Aufgaben**, direkt über dieser Liste. Sie liefern nur Kontext und blockieren keine der beiden Aufgaben. Eine Verknüpfung kann auf eine Aufgabe in einem anderen Space zeigen, wenn beide Einträge zugänglich sind.
