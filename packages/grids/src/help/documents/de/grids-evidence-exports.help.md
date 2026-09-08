---
id: grids-evidence-exports
title: Beweispaket exportieren
icon: ti ti-package-export
description: Ein begrenztes Paket der aktuell in Grids vorhandenen Belege erstellen und prüfen.
order: 147
---
Ein Beweisexport erfasst eine Basis oder Tabelle zu einem angegebenen Schnitt und verpackt die ausgewählten aktuellen und historischen Quellen zusammen mit einem Manifest und SHA-256-Hashes. Nutze ihn, wenn eine andere Person oder ein System eine prüfbare Übergabe statt eines bearbeitbaren CSV- oder JSON-Datasets benötigt.

Ein Beweispaket ist kein Compliance-Zertifikat. Es beschreibt die in Grids vorhandenen Belege und nennt fehlende Historie. Es rekonstruiert keine Ereignisse aus der Zeit vor der Aktivierung von Durable History.

Du benötigst **Verwalten**-Zugriff auf die Basis. Custom Apps, Workflows, API-Clients und die CLI können diese Prüfung nicht umgehen.

## Verfügbare Belege prüfen {icon="chart-bar"}

Öffne die Einstellungen der Basis und wähle **Beweisexporte**. **Verfügbare Belege** werden beim Öffnen der Seite aus der Basis berechnet. Der Wert ist keine gespeicherte Bewertung und aktiviert oder verändert nichts.

Die Zusammenfassung zählt aktuelle und gelöschte Datensätze, gespeicherte Revisionen und Audit-Ereignisse, gespeicherte Datei- und Dokumentbytes, Nummernkreise und dauerhafte Nummernvergaben. Klappe **Abdeckung nach gespeicherter Tabelle** auf, um jede Tabelle zu prüfen:

- **Historie aktiv:** Durable History hat ihre Ausgangsbasis vollständig aufgebaut. Der angezeigte Startzeitpunkt ist die früheste Abdeckung, die Grids zusichern kann.
- **Ausgangsbasis der Historie wird aufgebaut:** Bei der Aktivierung wird die aktuelle Ausgangsbasis noch kopiert. Die Abdeckung ist noch nicht vollständig.
- **Frühere Zustände nicht verfügbar:** Die Tabelle enthält bereits Datensätze, aber Durable History war nicht aktiviert. Frühere Zustände können deshalb nicht rekonstruiert werden.
- **Historie nicht aktiviert:** Eine leere Tabelle besitzt noch keinen dauerhaften Revisionsverlauf.
- **Historie unvollständig:** Gespeicherter Aktivierungsstatus und Abschluss der Ausgangsbasis stimmen nicht überein. Behandle die Abdeckung als unvollständig und bitte den Betreiber um Prüfung.

Die Finalisierung wird getrennt ausgewiesen, weil das Aktivieren von Durable History keine Datensätze finalisiert. Die Zeile zeigt, ob die Finalisierung aktiviert ist und wie viele Datensätze derzeit finalisiert sind. Tabellen im Papierkorb bleiben als Beweisquellen sichtbar, können von dieser Liste aber nicht geöffnet werden.

## Ein Paket erstellen {icon="package-export"}

:::steps
1. Öffne die Einstellungen der Basis und wähle **Beweisexporte**.
2. Wähle **Neuer Export**.
3. Wähle die vollständige Basis oder eine Tabelle aus. Lege optional einen Zeitraum für Revisionen, Audit-Ereignisse, Dokumente und Nummernvergaben fest. Aktuelle Datensätze und aktive Relationen werden immer aus dem Exportschnitt übernommen.
4. Behalte alle Belege ausgewählt oder entferne Bereiche, die die empfangende Person nicht benötigt.
5. Lies die Bereichsprüfung. Grenze Tabelle, Zeitraum oder ausgewählte Bereiche ein, wenn der bekannte Umfang ein Paketbudget überschreitet.
6. Wähle **Export einreihen**. Die Liste der letzten Pakete zeigt den Auftrag als eingereiht, laufend oder abgeschlossen.
7. Wähle **Herunterladen**, solange das abgeschlossene Paket verfügbar ist.
:::

Das Paket läuft nach sieben Tagen ab. Beim Ablauf werden seine gespeicherten Bytes entfernt. Erstelle einen neuen Export, wenn die empfangende Person weiterhin ein Paket benötigt.

## Enthaltene Inhalte verstehen {icon="list-check"}

| Bereich | Beweisquelle |
| --- | --- |
| Datensätze | Aktuelle und gelöschte gespeicherte Datensätze am Schnitt einschließlich Finalisierungsstatus |
| Durable History | Verfügbare unveränderliche Datensatzrevisionen und ihre Schemabedeutung |
| Audit | Gespeicherte Mutationsereignisse, Akteursbezeichnungen, Antworten und Anfragekontext |
| Schema und Konfiguration | Basis, Tabellen, Felder, Richtlinien, Finalisierungseinstellungen, Vorlagen und Schema-Snapshots |
| Relationen | Aktuelle Verknüpfungen, die von Relationen und **Referenziert von** verwendet werden; historische Relationszustände verbleiben in Revisionen |
| Dateien | Aktuelle und durch Revisionen geschützte Anhangbytes mit ihren gespeicherten Hashes |
| Dokumentartefakte | Exakte gespeicherte Dokumentbytes, Datensatz-Snapshots, Renderdaten, Renderer-Metadaten, Validierungsbelege und jedes exakte Artefakt; nichts wird erneut gerendert. |
| Nummernvergaben | Nummernkreise, Formatversionen und vergebene Werte |

Grids-Ressourcenreferenzen verwenden ihre öffentlichen IDs aus sechs Zeichen. UUID-förmige Werte ohne öffentliche ID im ausgewählten Grids-Bereich werden als stabile private Referenzen dargestellt, statt interne Kennungen offenzulegen. Derselbe Quellwert erhält innerhalb des Pakets dieselbe private Referenz.

Jedes Dokument gehört zu einer Grids-Tabelle und einem Datensatz. Wenn Dokumentartefakte ausgewählt sind, enthält ein Tabellenpaket die Dokumente dieser Tabelle im gewählten Zeitraum; ein Basispaket umfasst die Tabellen der Basis. Beide enthalten die exakten gespeicherten Artefakte und ihre Metadaten.

## Den Download prüfen {icon="shield-check"}

Auch die CLI verwaltet Exporte: `cld grids evidence preflight`, `create`, `list`, `get`, `retry`, `cancel` und `download`. Preflight und Create akzeptieren `--base` sowie optional `--body-file` mit `tableId`, `from`, `to` und `sections`. Create, Retry und Cancel benötigen `--yes`. Es gilt dieselbe Base-Admin-Berechtigung. Prüfe vor dem Download den zurückgegebenen Status: Eine angenommene Anfrage bedeutet noch kein fertiges Paket.

Öffne vor dem Herunterladen **Technische Details** und bewahre die angezeigten SHA-256-Werte für Paket und Manifest zusammen mit der Übergabe auf.

Wähle nach dem Herunterladen **Prüfbefehl kopieren** und führe den kopierten Befehl am Speicherort der TAR-Datei aus:

```bash
cld grids evidence verify package.tar \
  --sha256 <package-sha256> \
  --manifest-sha256 <manifest-sha256>
```

Das Prüfprogramm liest die TAR-Datei lokal, lädt sie nicht hoch und extrahiert sie nicht. Es prüft die sichere Archivstruktur und jede im Manifest deklarierte Datei. Es gibt Bereich, Schnitt, Abschnitte, Anzahlen und verfügbare historische Abdeckung aus. Nutze `--json` für ein maschinenlesbares Ergebnis. Eine fehlgeschlagene Prüfung beendet das Programm mit einem von null verschiedenen Status.

Der Befehl funktioniert offline und erfordert weder einen konfigurierten Cloud-Server noch eine Anmeldung. Wenn `cld` nicht verfügbar ist, führe dieselben Prüfungen manuell aus:

1. Berechne den SHA-256-Hash der vollständigen TAR-Datei und vergleiche ihn mit **Paket-SHA-256**.
2. Extrahiere die TAR-Datei, ohne sie zu bearbeiten.
3. Berechne den SHA-256-Hash von `manifest.json` und vergleiche ihn mit **Manifest-SHA-256**.
4. Berechne für jede verwendete Datei ihren SHA-256-Hash und vergleiche ihn mit dem passenden Eintrag im Manifest.
5. Lies Bereich, Schnitt, ausgewählte Abschnitte, Anzahlen, Grenzen und historische Abdeckung im Manifest, bevor du Schlussfolgerungen aus dem Paket ziehst.

Eine erfolgreiche Prüfung zeigt, dass die Bytes zum Paketmanifest und zu den mit der Übergabe bereitgestellten erwarteten Hashes passen. Sie belegt nicht, wer die Datei nach dem Download besaß, beweist weder Urheberschaft noch Aufbewahrungskette und stellt keine rechtliche Behauptung über die Datensätze auf.

## Eine fehlgeschlagene oder unvollständige Anfrage beheben {icon="lifebuoy"}

- **Bereich konnte nicht geprüft werden:** Wähle **Erneut versuchen**. Wenn die Prüfung erneut scheitert, bewahre den gewählten Bereich und die Fehlermeldung für den Betreiber auf.
- **Bekannter Bereich ist zu groß:** Wähle eine Tabelle, verkürze den Zeitraum oder exportiere weniger Abschnitte. Grids lässt den Auftrag scheitern, statt ein Paket beim Überschreiten einer Laufzeitgrenze unbemerkt zu kürzen.
- **Fehlgeschlagen oder abgebrochen:** Wähle **Erneut versuchen**, um einen neuen Versuch einzureihen. Der neue Versuch verwendet einen neuen Schnitt und ist nicht dasselbe Paket.
- **Eingereiht oder laufend, aber nicht mehr benötigt:** Wähle **Abbrechen**. Eine Abbruchanfrage kann einen Moment dauern, während der aktuelle begrenzte Lesevorgang beendet wird.
- **Abgelaufen:** Erstelle einen neuen Export. Die Bytes eines abgelaufenen Pakets können nicht erneut heruntergeladen werden.

Gewöhnliche CSV- und JSON-Exporte bleiben unverändert. Nutze diese Formate, wenn das Ziel eine Datenübertragung oder Analyse statt einer durch Hashes prüfbaren Beweisübergabe ist.
