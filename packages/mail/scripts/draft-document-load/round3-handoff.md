# Runde 3 angehalten – Handoff

Maintainer-Stopp: kein Mail-eigener Kollaborationsumbau. Erst gemeinsamer Plattformbaustein aus Notebooks in separatem PR gegen main; danach Mail-Umstellung und Zwei-Knoten-Lasttest.

PR #3229 bleibt auf 11604354ed777cfdf51812348b43a818da5b14ed. Dieser WIP ist unvollständig und ungeprüft; nicht mergen oder als funktionsfähige Architektur verwenden.

Gesichert: Statement-Probe im getrennten Harness; begonnene Optimierung des weiterhin SQL-pro-Edit arbeitenden Dienstes (Transaktionszustand wiederverwenden, Validierung zwischenspeichern), ein noch nicht angebundener Socket-Zugriffsleser und begonnene Commit-Nachrichten auf dem Awareness-Topic. Kein lazy Mail-Snapshot-Pfad gebaut. Kein neuer Lastlauf mit diesen Änderungen.

## SQL des unveränderten PR-Heads

Der isolierte Probe-Lauf machte nach Join genau einen Edit, 2 verbundene Editoren, keine Awareness und keine Reconnects. pg_stat_statements wurde nach Join zurückgesetzt. Ergebnis: 80 Top-Level-Statements, davon 5 Mess-Infrastruktur (2 Größenleser, 2 pg_stat_activity, 1 Reset) und **75 Anwendungsstatements**. Das enthält die erstmalige Übernahme; danach typischerweise 74. Der Probe-Lauf meldet erwartbar das Fehlen der absichtlich ausgeschalteten Disruptionsszenarien; er ist kein bestandener Lasttest.

Rohzähler: `.local/mail-draft-load/r3-statements-beforeb/one-edit-statements.json`. Der Quellstand war noch der unveränderte PR-Head; nur die Probe-Option war ergänzt. Counter zählt Top-Level-Statements, keine verschachtelten Trigger-Statements. Keine Aussage über SQL-freien Hot Path.

### Persistenz eines normalen Text-Edits

| SQL-Form | Anzahl | Zweck |
|---|---:|---|
| SELECT pg_backend_pid() | 1 | Backend für Abbruch merken |
| BEGIN | 1 | Persistenztransaktion beginnen |
| SELECT set_config(statement_timeout, …) | 1 | Statement-Laufzeit begrenzen |
| SELECT EXISTS FROM auth.users (account_expires) | 5 | Aktives Konto prüfen |
| SELECT EXISTS FROM mail.mailboxes (deleted_at) | 5 | Postfach-Lifecycle prüfen |
| SELECT a.permission FROM mailbox_access JOIN auth.access | 5 | Volle Grants inklusive Principals/Gruppen |
| SELECT a.permission FROM mailbox_assigned_access JOIN auth.access | 5 | Zugewiesene Grants |
| SELECT pg_advisory_xact_lock_shared(coverage) | 1 | Gegen Log-Pruning absichern |
| SELECT d.*, Sender-/Signatur-IDs … FOR UPDATE OF d | 6 | Dieselbe gesperrte Entwurfszeile erneut laden |
| SELECT 1 FROM draft_document_log_policy | 1 | Migrations-/History-Checkpoint; entfällt bei Prozess-Cache |
| SELECT adopted_at, edit_mode, doc_state, doc_cursor, doc_generation … FOR UPDATE | 3 | Menschliche Übernahme aus Log rekonstruieren |
| SELECT id FROM sender_identities (short_id/mailbox) | 2 | Öffentliche Sender-ID in UUID übersetzen |
| SELECT default_* FROM sender_identities … status=verified FOR SHARE | 2 | Verifizierten Sender validieren |
| UPDATE drafts SET adopted_at=COALESCE(…) RETURNING adopted_at | 0–1 | Erstmalige menschliche Übernahme |
| UPDATE drafts SET content…, doc_state, doc_cursor, doc_seq, revision… RETURNING revision | 1 | Vollständigen Zustand und Projektion speichern |
| INSERT draft_document_revisions | 1 | Authentifizierte historische Basis |
| SELECT draft…, identity…, source…, attachments… | 1 | Provider-Export vollständig projizieren |
| INSERT draft_provider_snapshots … ON CONFLICT DO NOTHING RETURNING id | 1 | Provider-Export vorbereiten |
| DELETE superseded draft_provider_snapshots … FOR UPDATE SKIP LOCKED | 1 | Noch nicht gestartete alte Exporte entfernen |
| COMMIT | 1 | Dauerhafte SQL-Bestätigung ermöglichen |

Summe im Probe-Lauf: **45** (mit Übernahme-UPDATE), danach **44** bei gleichem uncached Policy-Check. Fünf Zugriffsprüfungen: vor der Sperre, nach der Sperre, am Anfang von accept, vor Publish und vor Snapshot-Save. Sechs Zeilenladungen: initial, accept-assertWritable, Store.load für accept, Pre-Publish-assertWritable, Store.load für read und Save-assertWritable. Senderprüfung vor Publish und beim Speichern identisch wiederholt.

### Eine Zustellung / Autorenbestätigung

| SQL-Form | Anzahl | Zweck |
|---|---:|---|
| SELECT pg_backend_pid() | 1 | Abbruch |
| BEGIN | 1 | Zustellungs-Fence |
| SELECT set_config(statement_timeout, …) | 1 | Laufzeit |
| SELECT pg_advisory_xact_lock_shared(coverage) | 1 | Pruning-Fence |
| SELECT state, edit_mode, author_kind, doc_generation, doc_history_complete, doc_frozen_cursor FROM drafts … FOR SHARE | 1 | Send-/Generation-/Lifecycle-Fence |
| Dieselben vier Account-/Mailbox-/Grant-SELECTs wie oben | 4 | Aktuelle Berechtigung vor Zustellung |
| COMMIT | 1 | Fence freigeben |

**10 Statements je Fence**, durch Batching teils für mehrere bereits wartende Pakete gemeinsam. Beim Einzel-Edit: 2 Log-Echos (auch zum Autor) + 1 SQL-durable Snapshot an den Autor = **30**. Somit 45+30=75 gemessene Anwendungsstatements.

Ein zusätzliches Awareness-Paket kostet 10 für die Veröffentlichung plus 10 je Empfänger einschließlich Autor. Bei 2 Editoren also weitere 30: 74+30≈104 im ungebatchten stationären Fall. Das erklärt die ~103 SQL-Aufrufe/Edit im 200er-Lauf; dessen Nenner enthält Edits, aber der Zähler zusätzlich Awareness, Joins, Rechecks und Mess-SQL.

### Bedingte und interne Statements

- Assigned-only: zusätzlich SELECT draftVisibleTo pro Berechtigungsprüfung (Unterabfragen für Conversation-/Source-/Derived-Zugriff).
- Explizite Signatur: SELECT compose_templates-ID FOR SHARE; geänderte Auswahl führt über requireSelectableSignature weitere Account-/Mailbox-/Grant-/Template-Abfragen aus. Legacy-Signatursegmente lesen auswählbare Signaturen; vorhandene Segmente ggf. SELECT body_template. Nicht im Plaintext-Probe-Fall.
- Provider-INSERT-Konflikt: zusätzlich SELECT id FROM draft_provider_snapshots, um vorhandenen Export zu finden.
- Unseeded Join: UPDATE doc_state/doc_cursor/doc_seq und INSERT Revision; nicht pro normalem Edit.
- Revision-INSERT-Trigger: intern SELECT drafts FOR UPDATE und WITH historical … DELETE alte Revisionen nach Bytebudget; im Top-Level-Zähler nicht zusätzlich sichtbar.
- Abbruch: unabhängiges SELECT pg_cancel_backend(pid), anschließend nötigenfalls ROLLBACK. Kein normaler Erfolgsfall.
- Pruning ist eigener Hintergrundpfad: Coverage-Lock, paginierte Coverage-SELECTs und bedingte Idle-Watermark-UPDATEs. Nicht der Persistenz-/Zustellungsaufruf selbst.

Cleanup: keine Worker mehr; eigene Container mail-b3-r3-pg, mail-b3-r3-nats, mail-b3-r3-valkey samt anonymen Volumes entfernt. Vorher nur Basisdatenbank mail_load_test und 0 Streams/Consumer/Nachrichten/Bytes. Keine neuen /tmp-Verzeichnisse. Probe-Artefakte und r3-nats.conf verbleiben unter .local/mail-draft-load.
