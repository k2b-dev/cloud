---
id: grids-evidence-exports
title: Nachweispaket exportieren
icon: ti ti-package-export
description: Erstelle und prüfe ein begrenztes Paket der Nachweise, die Grids aktuell vorliegen.
order: 147
---
Ein Nachweispaket erfasst eine Base oder eine Tabelle zu einem festgelegten Exportzeitpunkt. Es verpackt die ausgewählten aktuellen und historischen Quellen mit einem Manifest und SHA-256-Hashes. Nutze es, wenn eine andere Person oder ein System eine prüfbare Übergabe braucht, keinen bearbeitbaren CSV- oder JSON-Datenbestand.

:::warning Kein Konformitätsnachweis
Ein Nachweispaket beschreibt die Nachweise, die Grids vorliegen, und nennt fehlenden Verlauf. Es rekonstruiert keine Ereignisse aus der Zeit, bevor der dauerhafte Verlauf aktiviert wurde.
:::

Du brauchst Zugriff **Verwalten** auf die Base. Grids Apps, Workflows, API-Clients und die CLI können diese Voraussetzung nicht umgehen.

## Die verfügbaren Nachweise prüfen {icon="chart-bar"}

Öffne **Base-Einstellungen → Nachweispakete**. Grids berechnet **Verfügbare Nachweise** beim Öffnen der Seite aus der Base. Der Wert ist keine gespeicherte Bewertung und aktiviert oder ändert nichts.

Die Zusammenfassung zählt aktuelle und gelöschte Datensätze, gespeicherte Revisionen und Audit-Ereignisse, gespeicherte Datei- und Dokumentinhalte, Nummernkreise und dauerhafte Nummernvergaben. Um jede Tabelle zu prüfen, wähle **Tabellenabdeckung prüfen**. Die Spalte **Historie** zeigt einen dieser Zustände:

:::reference
- **Aktiv seit** einem Datum: Der dauerhafte Verlauf hat seinen Ausgangsstand vollständig erstellt. Das Datum ist die früheste Abdeckung, die Grids zusichern kann.
- **Ausgangsstand wird erstellt:** Die Aktivierung kopiert noch den aktuellen Ausgangsstand. Die Abdeckung ist noch nicht vollständig.
- **Frühere Zustände nicht verfügbar:** Die Tabelle enthält schon Datensätze, aber der dauerhafte Verlauf ist nicht aktiviert. Grids kann frühere Zustände nicht rekonstruieren.
- **Nicht aktiviert:** Eine leere Tabelle hat noch keinen dauerhaften Revisionsverlauf.
- **Unvollständig:** Der gespeicherte Aktivierungsstatus und der Abschluss des Ausgangsstands stimmen nicht überein. Gehe von unvollständiger Abdeckung aus und wende dich zur Prüfung an den Betreiber.
:::

Die Spalte **Finalisiert** steht getrennt, weil das Aktivieren des dauerhaften Verlaufs keine Datensätze finalisiert. Sie zeigt **Nicht aktiviert** oder die Anzahl der aktuell finalisierten Datensätze. Tabellen im Papierkorb bleiben als Nachweisquellen sichtbar. Aus dieser Liste kannst du sie aber nicht öffnen.

## Ein Paket erstellen {icon="package-export"}

:::steps
1. Öffne **Base-Einstellungen → Nachweispakete**.
2. Wähle **Neues Paket**.
3. Wähle **Gesamte Base** oder eine Tabelle.
4. Optional: Lege einen **Zeitraum** für Revisionen, Audit-Ereignisse, Dokumente und Nummernvergaben fest. Aktuelle Datensätze und aktive Relationen stammen immer vom Exportzeitpunkt.
5. Lass alle Nachweise ausgewählt oder entferne die Bereiche, die die empfangende Person nicht braucht.
6. Lies die Prüfung des Umfangs. Überschreitet der bekannte Umfang ein Paketbudget, grenze Tabelle, Zeitraum oder Bereiche ein.
7. Wähle **Nachweispaket erstellen**. Die Liste der letzten Pakete zeigt den Auftrag als **Eingereiht**, **Läuft** oder **Abgeschlossen**.
8. Wähle **Herunterladen**, solange das abgeschlossene Paket verfügbar ist.
:::

Das Paket verfällt nach sieben Tagen. Beim Verfall entfernt Grids seine gespeicherten Inhalte. Braucht die empfangende Person weiterhin ein Paket, erstelle ein neues.

## Den Inhalt des Pakets verstehen {icon="list-check"}

| Bereich | Nachweisquelle |
| --- | --- |
| **Datensätze** | Aktuelle und gelöschte gespeicherte Datensätze zum Exportzeitpunkt, einschließlich Finalisierungsstatus |
| **Beständige Historie** | Verfügbare unveränderliche Datensatzrevisionen und ihre Schemabedeutung |
| **Audit** | Gespeicherte Änderungsereignisse, Bezeichnungen der Akteure, Antworten und Anfragekontext |
| **Schema und Konfiguration** | Base, Tabellen, Felder, Richtlinien, Finalisierungseinstellungen, Vorlagen und Schema-Momentaufnahmen |
| **Beziehungen** | Aktuelle Verknüpfungen, die Relationen und **Referenziert von** verwenden. Historische Zustände von Relationen bleiben in den Revisionen. |
| **Dateien** | Aktuelle und durch Revisionen geschützte Anhänge mit ihren gespeicherten Hashes |
| **Dokumentartefakte** | Exakt gespeicherte Dokumentinhalte, Datensatz-Momentaufnahmen, Renderdaten, Renderer-Metadaten, Validierungsnachweise und jedes exakte Artefakt. Grids rendert nichts erneut. |
| **Nummernvergaben** | Nummernkreise, Formatversionen und vergebene Werte |

Referenzen auf Grids-Ressourcen verwenden ihre öffentlichen IDs aus sechs Zeichen. Ein UUID-förmiger Wert ohne öffentliche ID im ausgewählten Grids-Bereich erscheint als stabile private Referenz. So bleiben interne Kennungen privat. Derselbe Quellwert erhält innerhalb des Pakets dieselbe private Referenz.

Jedes Dokument gehört zu einer Grids-Tabelle und einem Datensatz. Ist **Dokumentartefakte** ausgewählt, enthält ein Tabellenpaket die Dokumente dieser Tabelle im gewählten Zeitraum. Ein Paket für die Base umfasst die Tabellen der Base. Beide enthalten die exakt gespeicherten Artefakte und ihre Metadaten.

## Ein Paket über die CLI erstellen {icon="terminal-2"}

Die CLI bietet `cld grids evidence preflight`, `create`, `list`, `get`, `retry`, `cancel` und `download`. `preflight` und `create` akzeptieren `--base` und optional `--body-file` mit `tableId`, `from`, `to` und `sections`. `create`, `retry` und `cancel` erfordern `--yes`. Du brauchst denselben Zugriff **Verwalten** auf die Base.

Prüfe vor dem Herunterladen den zurückgegebenen Status. Eine angenommene Anfrage bedeutet noch kein fertiges Paket.

## Den Download prüfen {icon="shield-check"}

:::steps
1. Wähle vor dem Herunterladen **Details** am Paket.
2. Bewahre die Werte **Paket-SHA-256** und **Manifest-SHA-256** zusammen mit der Übergabe auf.
3. Lade das Paket herunter.
4. Wähle in **Paketdetails** unter **Offline-Prüfung** die Option **Befehl kopieren**.
5. Führe den kopierten Befehl dort aus, wo die TAR-Datei liegt.
:::

```bash
cld grids evidence verify package.tar \
  --sha256 <package-sha256> \
  --manifest-sha256 <manifest-sha256>
```

Das Prüfprogramm liest die TAR-Datei lokal. Es lädt sie nicht hoch und entpackt sie nicht. Es prüft die sichere Archivstruktur und jede Datei, die das Manifest deklariert. Es gibt Bereich, Exportzeitpunkt, Abschnitte, Anzahlen und die verfügbare Abdeckung des Verlaufs aus. Nutze `--json` für ein maschinenlesbares Ergebnis. Eine fehlgeschlagene Prüfung endet mit einem Status ungleich null.

Der Befehl läuft offline. Er braucht keinen konfigurierten Cloud-Server und keine Anmeldung. Ist `cld` nicht verfügbar, führe dieselben Prüfungen manuell aus:

:::steps
1. Berechne den SHA-256-Hash der vollständigen TAR-Datei. Vergleiche ihn mit **Paket-SHA-256**.
2. Entpacke die TAR-Datei, ohne sie zu bearbeiten.
3. Berechne den SHA-256-Hash von `manifest.json`. Vergleiche ihn mit **Manifest-SHA-256**.
4. Berechne für jede Datei, auf die du dich stützt, ihren SHA-256-Hash. Vergleiche ihn mit dem passenden Eintrag im Manifest.
5. Lies Bereich, Exportzeitpunkt, ausgewählte Abschnitte, Anzahlen, Grenzen und Abdeckung des Verlaufs im Manifest, bevor du Schlüsse ziehst.
:::

Eine erfolgreiche Prüfung zeigt, dass die Bytes zum Paketmanifest und zu den erwarteten Hashes aus der Übergabe passen. Sie zeigt nicht, wer die Datei nach dem Download hatte. Sie beweist weder Urheberschaft noch Aufbewahrungskette und trifft keine rechtliche Aussage über die Datensätze.

## Eine fehlgeschlagene oder unvollständige Anfrage beheben {icon="lifebuoy"}

:::reference
- **Der Umfang konnte nicht geprüft werden:** Wähle **Erneut versuchen**. Scheitert es erneut, bewahre den gewählten Bereich und die Fehlermeldung für den Betreiber auf.
- **Der bekannte Umfang ist zu groß:** Wähle eine Tabelle, verkürze den Zeitraum oder exportiere weniger Bereiche. Überschreitet ein Paket eine Laufzeitgrenze, lässt Grids den Auftrag scheitern. Grids kürzt nie unbemerkt ein Paket.
- **Fehlgeschlagen** oder **Abgebrochen:** Wähle **Erneut versuchen**, um einen neuen Versuch einzureihen. Ein neuer Versuch nimmt einen neuen Exportzeitpunkt und ist deshalb nicht dasselbe Paket.
- **Eingereiht** oder **Läuft**, aber nicht mehr nötig: Wähle **Abbrechen**. Der Abbruch kann einen Moment dauern, bis der aktuelle begrenzte Lesevorgang endet.
- **Verfallen:** Erstelle ein neues Paket. Die Inhalte eines verfallenen Pakets kannst du nicht erneut herunterladen.
:::

Normale CSV- und JSON-Exporte bleiben unverändert. Nutze sie für Datenübertragung oder Analyse, wenn du keine per Hash prüfbare Nachweisübergabe brauchst.
