---
id: kit-sql-console
title: "Daten mit der SQL-Konsole untersuchen"
icon: ti ti-terminal
description: "Tabellen ansehen, SELECT-Abfragen ausführen und gemeinsame Abfragen speichern."
order: 50
---

## Konsole öffnen {icon="terminal"}

Öffne **SQL-Konsole** in der Seitenleiste, nachdem ein App-Admin die gemeinsame
Datenbank aktiviert hat. Der Eintrag ist im Benutzungs- und Bearbeitungsmodus
verfügbar. Du musst kein Script starten. Ist die Datenbank deaktiviert oder
nicht erreichbar, aktualisiere ihren Status, nachdem ein Admin den Zugriff
wiederhergestellt hat.

## Tabellen und Abfragen {icon="table"}

Wähle eine Tabelle, um jeweils 50 Datensätze anzusehen. **Struktur** zeigt ihre
Spalten. **Als Abfrage öffnen** bereitet einen SELECT im Editor vor. Er wird
nicht ausgeführt; ungespeicherte Änderungen werden nicht ohne Rückfrage ersetzt.

Der Monospace-Editor hebt SQL hervor, ohne Autovervollständigung. Klicke
**Ausführen** oder drücke Strg/Cmd+Enter. Erlaubt sind SELECT-Abfragen aus Kits
unterstütztem Teilumfang. Ein abschließendes Semikolon ist erlaubt; mehrere
Statements, CTEs, Kommentare und schreibende Statements nicht. Details stehen
in der [Datenbankreferenz](/app/kit/help/kit-sdk-db).

Ergebnisse sind auf 1.000 Zeilen und 16 MiB begrenzt. Größere Ergebnisse führen
zu einem klaren Fehler: Nutze LIMIT/OFFSET oder wähle weniger Spalten.
Datenbankanfragen haben einen Timeout von 15 Sekunden. **Abbrechen** beendet
das Warten und fordert den Abbruch an; eine sofortige Beendigung auf dem Server
ist damit nicht garantiert. Die Abfragen verändern keine Daten.

Das Ergebnis zeigt Zeilenanzahl und Laufzeit. Änderst du danach das SQL, wird
das vorherige Ergebnis entsprechend markiert. **CSV exportieren** lädt nur
das angezeigte Ergebnis herunter, mit Semikolon und UTF-8-BOM.

## Abfragen speichern {icon="device-floppy"}

App-Admins können gemeinsame Abfragen **speichern**, umbenennen und löschen. Strg/Cmd+S speichert. Nutzer mit
Use-Berechtigung können gespeicherte Abfragen lesen, einen ungespeicherten
Entwurf bearbeiten und ausführen. Das Öffnen führt eine Abfrage niemals aus.

Gespeichert werden Name und SQL, keine Ergebnisse. Abfragen sind über Nutzer
und Geräte hinweg geteilt. Beim Speichern wird die Revision geprüft: Hat jemand
die Abfrage geändert oder gelöscht, bleibt dein Entwurf erhalten. Kopiere dein SQL, bevor du die
aktuelle Version öffnest.

Bei ungespeichertem SQL erfolgt vor Ersetzen oder Verlassen eine Rückfrage.
Entwürfe bleiben nach einem Neuladen nicht erhalten. Gespeicherte Abfragen
überleben Deaktivierung und Reset der Datenbank. Mit der Kit-App werden sie
gelöscht. Nach einem Reset musst du aktualisieren und Abfragen bewusst erneut
ausführen; bisherige Tabellen können fehlen.

## CLI verwenden {icon="code"}

Mit diesen Befehlen liest du gespeicherte Abfragen:

    cld kit queries list <app-id>
    cld kit queries get <app-id> <query-id>

Create akzeptiert ein JSON-Objekt mit name und sql über `--input-file` (oder `--stdin`); update benötigt
zusätzlich revision. Delete erfordert `--revision` und `--yes`. Run benötigt die
zuvor gelesene Revision über `--revision`.

UI und CLI prüfen dieselben App-Berechtigungen. SQL zu speichern führt es
nicht aus.

Unter **Info** im Ergebniskasten siehst du jede Tabelle einmal mit Zeilenanzahl, Spaltennamen und Typen, während der SQL-Editor offen bleibt. Auch Abfragefehler erscheinen hier. **Speichern** fragt bei einer neuen Abfrage nach einem Namen und aktualisiert eine bestehende Abfrage.

Agenten lesen dieselbe Struktur über die vorhandenen Lese-Capabilities: Generation aus `kit.database.status` holen, dann `kit.database.read` mit `tables.list` und `schema.get` für die benötigten Tabellen aufrufen. Dafür reicht die Use-Berechtigung; Daten werden nicht verändert.

**Speichern** steht neben **Aktualisieren**. Bei einer neuen Abfrage fragt ein bereits verwendeter, exakt gleicher Name vor dem Überschreiben nach. Gleichzeitige Änderungen verhindern das Überschreiben. Die Seitenleiste zeigt gespeicherte Abfragen erst an, sobald es Einträge gibt; ihr Hover-Menü enthält **Umbenennen** und **Löschen**. Namen sind innerhalb einer App eindeutig. Umbenennen erhält ungespeicherte Änderungen im Editor.

Beim Öffnen einer Tabelle wechselst du mit **Daten / Struktur** die Ansicht. Das Tabellenmenü enthält **Als Abfrage öffnen** und **CSV exportieren**. Die Seitennavigation erscheint nur bei mehreren Seiten. Im SQL-Ergebnisbereich liegt **CSV exportieren** im Ergebnismenü.

## SQL-Grundlagen {icon="school"}

Ersetze `todos` und die Spalten durch Namen aus **Info**. Führe jedes Beispiel einzeln aus.

### Auswählen, filtern und sortieren

```sql
SELECT id, title FROM todos WHERE done = 0 ORDER BY id DESC LIMIT 50;
```

`SELECT` wählt Spalten aus, `FROM` die Tabelle, `WHERE` filtert und `ORDER BY` sortiert. `DESC` bedeutet absteigend. Texte stehen in einfachen Anführungszeichen:

```sql
SELECT id, title FROM todos WHERE title LIKE '%Rechnung%' LIMIT 50;
```

### Zählen und gruppieren

```sql
SELECT done, COUNT(*) AS anzahl FROM todos GROUP BY done;
```

`SUM(betrag_cent)` summiert eine vorhandene Betragsspalte, `AVG` bildet den Durchschnitt. Prüfe vorher die Spaltennamen unter **Info**.

### Fehlende Werte und weitere Seiten

```sql
SELECT id, title FROM todos WHERE title IS NULL LIMIT 50;
```

Benutze `IS NULL`, nicht `= NULL`. Mit stabiler Sortierung und `OFFSET` liest du die nächste Seite:

```sql
SELECT id, title FROM todos ORDER BY id LIMIT 50 OFFSET 50;
```

### Parameter für Agenten

Die Capability `kit.database.sql` erhält `id`, die aktuelle `generation`, `sql` und `params`. Beispiel: `sql: "SELECT id, title FROM todos WHERE title = ? LIMIT 50"` mit `params: ["Rechnung prüfen"]`. Werte werden gebunden; baue sie nicht durch String-Verkettung ins SQL ein. Die GUI hat derzeit keine separate Parametereingabe.

Ein unbekannter Tabellen- oder Spaltenname lässt sich mit **Info** prüfen. `SELECT * FROM *` ist ungültig: Hinter `FROM` muss ein Tabellenname stehen. Bei zu vielen Ergebnissen begrenze Zeilen und Spalten. SQL-Schreiben wird nicht unterstützt; Agenten verwenden dafür `kit.database.write` mit Bestätigung.
