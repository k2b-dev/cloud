# Code Mode: Umsetzung des Production-Readiness-Reviews

Stand: 12. September 2026. Grundlage ist
`assistant-code-mode-production-readiness-review.md`. Änderungen sind lokal;
kein Commit und kein Produktionsrollout wurden vorgenommen.

## Umgesetzt

- **B1:** Geteilte Apps und Skripte benötigen bei Nutzern ohne Manage-Recht
  für jeden Capability-Aufruf eine ausdrückliche Freigabe, auch für Queries.
  Persönliche gemerkte Freigaben werden nicht übernommen; „immer erlauben“
  steht hier nicht zur Verfügung. Die Freigabe nennt die Ressource und erklärt,
  dass Ergebnisse in ihren geteilten Speicher gelangen können. Rechte werden
  bei der Ausführung erneut geprüft. Eigene/verwaltete Ressourcen und
  Einmalskripte behalten das normale Freigabemodell.
- **B2:** Manage-Nutzer können Ressourcen löschen: derselbe Service für API,
  Studio-Menü, CLI `assistant code delete ID --yes` und Plattform-Administration.
  Zugriffseinträge werden entfernt, die externe Datenbankbereinigung wird
  transaktional eingeplant. Kein zusätzliches Agenten-Löschwerkzeug.
- **W1:** CSV-Dateien unterstützen explizite Kodierung, etwa Windows-1252.
  Ungültiges UTF-8 scheitert verständlich statt Namen still zu beschädigen.
  Gültige einspaltige CSVs funktionieren auch ohne Delimiter-Angabe.
- **W2:** Datenbank- und Storage-Aufrufe pausieren die kurzen Bereitschafts-
  und Interaktionsfristen. Das äußere Ausführungsbudget bleibt bestehen.
- **W3/W5:** `code_run` erhält einen knappen Prompt-Hinweis; der Skill erklärt
  menschenlesbare Ergebnisse wiederverwendbarer Skripte.
- **W4:** Offene Freigaben bleiben beim Wechsel des Chats sichtbar und nennen
  den ursprünglichen Chat, auch auf der leeren Chat-Startseite.
- **W8:** Exporte landen mit lesbarem Namen unter `/files`. Die vorhandene
  atomare Kollisionsbehandlung bestimmt den tatsächlichen Pfad. Der Upload
  unterstützt dafür ein validiertes Verzeichnis; reservierte Pfade bleiben
  geschützt. `code_export` liefert den tatsächlichen Serverpfad zurück.
- **W9:** Bei einem Quelltextkonflikt bleibt der eigene Entwurf erhalten. Man
  kann ihn herunterladen oder nach ausdrücklicher Bestätigung die aktuelle
  Fassung laden. Kein zusätzlicher Merge-Editor.
- **Discovery:** Dateiauswertung, App-Bau und „Was kannst du?“ stehen als
  Starter bereit. Die ersten beiden hängen den verfügbaren Code-Mode-Skill
  über die vorhandene Attachment-Mechanik an. Bestehender Text bleibt erhalten;
  fehlende/deaktivierte Skills verhindern den Texteinstieg nicht.

Skill-Referenzen, generierter Snapshot, CLI- und Fibel-Dokumentation wurden
angepasst. Keine neue Tool-Familie, keine Freigabe-Abkürzung und kein eigener
Discovery-Skill.

## Geprüft

- Disposable-Postgres/rsql-Integration: **25 Tests, 200 Assertions bestanden**.
  Darunter Query-Zustimmung, ignorierte persönliche Freigaben, Ablehnung,
  Wiederholungen ohne Doppelausführung sowie Manager-Löschung und Cleanup.
- Chromium-Worker: **58 Assertions bestanden**, einschließlich PDF/XLSX,
  lokaler Dateiauswahl, Windows-1252, UTF-8-Fehler und einspaltiger CSV.
- **W7:** 41.000.025 Byte CSV, 500.000 Zeilen, exakte Summe 21.000.000;
  Verarbeitung im Worker mit `work.run` rund **0,9 Sekunden** auf diesem Mac.
  Das rechtfertigt derzeit keinen zusätzlichen Streaming-Parser. Es ist keine
  Speicher- oder Laufzeitgarantie für andere Geräte oder sämtliche Formate.
- Skill/Snapshot und Startseite: **10 Tests, 400 Assertions bestanden**.
- Freigabe-Rendering: **5 Assertions bestanden**, einschließlich Herkunftschat
  und Entfernen nach Abbruch. Upload-Verzeichnis: fokussierter Client-Test grün.
- Assistant und Cloud: rohe TypeScript-Prüfung ohne Diagnose.
- `git diff --check` bestanden; fremde Änderungen wurden nicht bearbeitet.

## Echte Agentenläufe und verbleibende Rollout-Grenzen

Der Entwicklungs-CLI-Lauf `U4gKvs` erklärte den CSV-Einstieg verständlich und
forderte Eingaben an, ohne eine App zu erstellen oder andere Apps abzufragen.
Er benötigte zwei Tool-Aufrufe und rund 27 Sekunden.

Der CSV-Lauf `4WyrZy` mit dem konfigurierten Modell und Skill-Template 20 zeigte
zusätzliche Agentenfehler: zuerst falscher File-Rückgabetyp, danach Abschneiden
der ersten Datenzeile und zunächst Verlinken vor `code_export`. Der Export selbst
war korrekt kodiert und unter `/files/ergebnis.csv` abrufbar; die berichtete
Summe war **falsch: 24,66 statt 37,00 Euro**. Das ist ausdrücklich kein grüner
Akzeptanztest. Deshalb präzisiert Template 21 direkt im kompakten Einstieg:
`File` als Rückgabe, Datenzeilen ohne Kopfzeile und die drei Export-Schritte.
Die unveränderte Wiederholung mit Template 21 (`NSZD8F`) war erfolgreich:
ein `code_run`, drei Zeilen, alle drei Namen mit korrekten Umlauten, 3.700 Cent,
ein `code_export` und erfolgreicher `present`-Link. Insgesamt sechs Tool-Aufrufe
in rund 48 Sekunden, keine Reparaturschleife und keine erstellte Ressource.
Die Diagnose bestätigt, dass der aktualisierte Skill geladen wurde.
Eine Einzelauswertung belegt keine allgemeine Zuverlässigkeit des Modells.

Der vollständige CLI-Host-Testlauf bleibt untersuchungsbedürftig: zuletzt
**7 bestanden, 1 Timeout**. Der Drucktest besteht isoliert in rund 10 Sekunden;
im vollständigen Lauf hängt ein Worker-Start. Ein gezielter Lauf nach dem
langen Freigabetest kam bis zum siebten Schleifendurchgang. Die Kompilierung
ist abgeschlossen; prozessseitige Timer laufen weiter, aber parallele
Browser-Inspektionen antworten ebenfalls nicht.
Der neue Test mit 17 Sekunden Datenbank- plus 17 Sekunden Storage-Wartezeit
besteht. Die Ursache des intermittierenden Hängers ist noch nicht belegt;
Fristen wurden nicht erhöht und Assertions nicht abgeschwächt.

Die Browser-Sitzung zeigte die Anmeldung statt eines eingeloggten Assistant.
Der vollständige sichtbare Starter-/Chip-Klickpfad und die Mehrnutzer-Freigabe
im echten Browser sind daher noch nicht abgenommen. Die gezielten Render- und
Service-Tests ersetzen diese Abnahme nicht. Ebenso offen bleiben längere
Tab-Schließen/Resume-Prüfungen, mobile Suspendierung und die rsql-Konfiguration
der Zielinstanz. Ohne konfigurierte Datenbank bleibt `DB_NOT_CONFIGURED` das
beabsichtigte Verhalten.

**Rollout-Empfehlung:** Die konkreten Sicherheits- und Produktkorrekturen können
reviewt werden. Breiten Rollout erst nach reproduzierbar grüner CLI-Host-Serie,
den offenen UI-Abnahmen freigeben. Die CSV-Agenten-Wiederholung ist bestanden.

Der lokale Entwicklungsstack ist nach dem Refresh wieder vollständig gesund:
24 Apps bereit, keine gestoppt oder ungesund.
