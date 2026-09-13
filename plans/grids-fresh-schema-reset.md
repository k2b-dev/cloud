# Grids: eine Schemadefinition, frischer Bestand

Stand: 14. September 2026. Lokale Umsetzung und vollständige Löschung des lokalen
Grids-Bestands ausdrücklich freigegeben. Kein Produktions-Reset oder Deployment.
Dieser Plan ersetzt den früheren gezielten Alpha-Cut.

## Vertrag

`packages/grids/src/migrate.ts` definiert ausschließlich den aktuellen Zustand:
56 Tabellen, bestehende Constraints, Indizes, Funktionen, Trigger und Health-View.
Der Start setzt die Core-Workflow-Tabellen voraus, hält denselben Advisory-Lock und
führt die Definition transaktional aus. Ein zweiter oder konkurrierender Start
erhält Daten und Schema. Es gibt keine Datenkonverter, Marker oder Alpha-Gates.

Hash-Algorithmen bleiben unverändert; nur Versionsfelder entfallen. Fachliche
Versionen, eingefrorene Werte, Berechtigungen, Historie, Issuance-Receipts, Claims,
Nummernkreise und Workflow-Pins bleiben. Scanner verwenden nur `inputSources`.

## Lokaler Reset

Ziel: PostgreSQL `localhost`, Datenbank `ipa`; NATS `127.0.0.1:4222`, Namespace
`dev`. Nur Grids stoppen. Keine ganze Datenbank, kein gemeinsames Volume und
keine fremden App-Schemata löschen. Der Reset ist destruktiv; diese ausdrücklich
verwerfbaren Testdaten werden nicht in eine neue Base übernommen.

Inventur vor dem Reset: 2 Bases, 30 Records, 4 Dokumente, 4 Kernel-Workflows,
3 Grids-gebundene Service-Accounts und 4 zugehörige Credentials. Die tatsächlichen
Postgres-Fremdschlüssel zeigen keine fremden Verweise in `grids`. Kein fremdes
Access-Binding, OAuth-Client oder Mailbox verweist auf die zu löschenden Grants
oder Service-Accounts. Diese Aussagen vor einer erneuten Verwendung neu prüfen.

Reihenfolge in **einer** Postgres-Transaktion:

1. Grids-Access-IDs aus `base_access` und `custom_app_access`, Grids-gebundene
   Service-Accounts und deren Grants sowie Kernel-Workflow-/Event-IDs erfassen.
2. Fremdschlüssel erneut prüfen. Gemeinsam verwendete Grants behalten; bei
   fremden Referenzen auf ein Grids-Service-Konto anhalten und Scope klären.
3. `workflows.event_delivery` für die erfassten Workflows oder Events löschen.
4. `workflows.workflow`, `workflows.event`, `workflows.dependency_signal` jeweils
   nur mit `app_id = 'grids'` löschen. Kernel-Kinder werden per FK entfernt.
5. `capabilities.idempotency_claims` und `capabilities.executions` nur mit
   `app_id = 'grids'` löschen, damit keine alten Ergebnisse wiedergegeben werden.
6. `DROP SCHEMA grids CASCADE`.
7. Nur erfasste, nicht fremd verwendete `auth.access` löschen; Mandate nur mit
   `owner_app_id = 'grids'`; danach die erfassten resource-bound Service-Accounts
   samt ihren Credentials löschen. Delegierte Nutzerkonten bleiben unberührt.
8. Commit. Core, andere Apps, deren Grants, Chats, Skills und Audit-Historie bleiben.

NATS-Ressourcen zunächst vollständig inventarisieren. Ausschließlich Streams mit
Metadaten `sync.namespace=dev`, `sync.owner=grids` und einem dieser IDs entfernen:
`grids:workflow-record-events`, `grids:evidence-export`,
`grids:controlled-destruction`, `grids:workflows`,
`grids:external-record-operation-retention`, `grids:records`, `grids:metadata`,
`grids:workflow-runtime`, `grids:workflow-runs`. Die Inventur ergibt 20 Streams
einschließlich zugehöriger KV-/Dead-Letter-Streams. Keine Namenspräfixe erraten
und keine Streams anderer Namespaces löschen.

Grids anschließend neu bauen/starten. Gateway-Registrierung und geschützte
Grids-Route prüfen, leeren Bestand bestätigen und mit einem zweiten Start die
Idempotenz prüfen. Alte Grids-Links in fremden Chats bleiben bewusst erhalten,
zeigen aber auf entfernte Ressourcen.

## Nachweis

- Referenzkatalog aus isolierter Datenbank mit dem vorherigen Writer erstellt.
  Peer-Review: alle 105 nicht durch Constraints erzeugten Indizes, 23 Funktionen,
  12 Trigger und der Health-View erhalten; nur beabsichtigte Marker-/Provenienz-
  Spalten, Tabellen und Constraints entfernt.
- Neun Schema-Vertragstests prüfen unter anderem wiederholten/konkurrierenden
  Start, Datenbestand, Kernel-Abhängigkeit und aktuelle Dokument-Invarianten.
- Gesamtsuite nutzt eigene zufällige Testdatenbank und Sync-Namespaces. Kein Test
  schreibt in die lokale Anwendungsdatenbank. Lokale Sync-Testinstanz nutzt eine
  Replik, passend zum einzelnen Entwicklungsbroker.
- Abnahme: 2.950 Tests über alle acht Phasen grün, kein Fehler und kein Skip;
  zusätzlich 15 Hilfe-/Skill-Vertragstests grün. Der Runner nimmt künftig auch
  das Verzeichnis `test/` auf. Drei DOM-Tests werden ausdrücklich in der
  Browser-Phase ausgeführt, statt serverseitig zu laufen oder übersprungen zu
  werden. Die Reopen-Prüfung des Sync-Workers nutzt ebenfalls eine Replik.
- Raw Grids-Typecheck, Biome für den Änderungssatz und Skill-Check grün.
  Fallow-Audit: keine Dead-Code-/Import-Findings im Änderungssatz. Der komplette
  Grids-Scan meldet 24 bestehende Kandidaten außerhalb dieses Schnitts (darunter
  dynamisch geladene Testdateien); globale Komplexitäts-/Duplikatmeldungen sind
  kein neuer fachlicher Fehler und wurden nicht durch breite Umbauten verdeckt.
- Globaler Fibel-Dokumentationscheck bleibt wegen vorhandener Placeholder-
  Formulierung in `docs/en/applications/kit.md` rot; keine Grids-Diagnose.
  Englische geänderte Dokumentation zusätzlich mit Harper geprüft; technische
  Namen und bestehende, sachfremde Hinweise nicht mechanisch umgeschrieben.
- Zwei unabhängige Peer-Reviews: Schema-Erhalt sowie Runtime-/Reset-Grenzen.
  SQL-Arity bei Query-Issuance, altes Scanner-CLI-Beispiel und veraltete Doku-
  Aussagen korrigiert. Keine offenen bestätigten Findings in diesem Schnitt.

## Ausgeführt

Der lokale Reset wurde nach Commit des Vertragsumbaus ausgeführt: 3 erfasste
Grids-Service-Accounts, 7 Grants, 4 Workflows und 84 Events; 20 inventarisierte
Grids-NATS-Streams entfernt. Andere App-Daten blieben erhalten. Die temporäre
Referenzdatenbank wurde anschließend entfernt.

`bun run dev:rebuild grids` war nach einem transienten Paket-Download-Fehler im
zweiten Versuch erfolgreich. `bun run dev:restart grids` ebenfalls erfolgreich:
Container gesund, Gateway-Registrierung vorhanden, `/app/grids` liefert ohne
Anmeldung den erwarteten HTTP-302-Redirect. Vor und nach dem zweiten Start:
56 Tabellen, 0 Bases, 0 Records, 0 Dokumente; identische Spaltenkatalog-Signatur
`ade031353dffd96dfe06086dea8a8e376af3132773fa6f1f8311a32e6a181a6d`.
