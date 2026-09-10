# Assistant: Kompakte Diktiersteuerung im Composer

Stand: 10. September 2026. Vereinbarter Folgeplan zur vorhandenen Audio-Implementierung. Umsetzung anschließend freigegeben und am 10. September umgesetzt.

## Ziel

Die Diktierfunktion erscheint als einzelner Icon-Button direkt links neben Senden beziehungsweise dem dortigen Antwort-Stop-Button. Die bisherige beschriftete Schaltfläche links und die doppelten Fehlermeldungen oberhalb des Composers entfallen. Aufnahme, Transkription, Wiederholung und Verwerfen bleiben an den vorhandenen dauerhaften Diktatauftrag gebunden.

## Verhalten

| Zustand | Darstellung und Aktion |
| --- | --- |
| Bereit | Mikrofon-Icon ohne sichtbaren Text; Tooltip und zugänglicher Name „Diktieren“. Klick startet die Aufnahme. Ohne verfügbares Audio-Modell deaktiviert, mit verständlicher Erklärung. |
| Start/Mikrofonfreigabe | Ladeanzeige; keine zweite Aufnahme starten. Noch keine laufende Aufnahme vortäuschen. |
| Aufnahme | Eigene Aufnahmeleiste mit × zum Verwerfen, breiter neutraler Wellenform aus 48 pegelabhängigen Balken und separater quadratischer Stopptaste. Stop beendet die Aufnahme und startet die Verarbeitung. Bei reduzierter Bewegung bleibt die Wellenform statisch. |
| Verarbeitung | Loader während WAV-Finalisierung, Upload, Queue, Transkription und Übernahme. Bei Hover oder Tastaturfokus erscheint `ti-trash`; der zugängliche Name lautet „Diktat verwerfen“. Touch benötigt keinen Hover: derselbe Button ist antippbar, die Abbruchaktion muss verständlich erkennbar sein. |
| Fehler | Kein großer Statusblock über dem Composer. Ein nicht automatisch ablaufender Fehler-Toast mit „Erneut versuchen“. Der Button zeigt einen kompakten Fehler-/Wiederholungszustand, damit Retry nach manuellem Schließen des Toasts erreichbar bleibt. |
| Fertig | Nach sicherer Übernahme zurück zum Mikrofon. Kein automatisches Absenden. Ist automatische Übernahme wegen Navigation, Reload oder zwischenzeitlicher Änderung nicht sicher, kompakt „Diktat bereit“ mit explizitem „Einfügen“ anbieten. |

Button-Abmessungen und Position bleiben über alle Zustände stabil. Bestehende Senden-/Antwort-Stop-Semantik erhalten. Tastaturbedienung, Fokus, Tooltip, Statusansage, Dark Mode und schmale Ansichten berücksichtigen. Kein eigenes Audio-Verhalten in der generischen UI-Bibliothek.

## Fehler und Wiederholung

Die vorhandene Toast-API unterstützt `duration: 0`, eine CTA sowie Update/Dismiss-Handles. Pro Operation höchstens einen Fehler-Toast führen und bestehende Hinweise aktualisieren. Kein zusätzlicher identischer Composer-/Seitenfehler. Manuelles Schließen oder Verdrängung durch das Toast-Limit darf weder Aufnahme noch Auftrag verwerfen. Bei Navigation muss eine Toast-Aktion weiterhin die ursprüngliche Operation adressieren; nach Owner-Unmount keine toten Callbacks behalten. Dauerhafte Aufträge bleiben über die autorisierte Query wiederauffindbar.

Retry setzt am fehlgeschlagenen Schritt an: Upload mit denselben Bytes und derselben Operations-ID, Server-Transkription über vorhandenes Retry, Ergebnisübernahme ohne neuen Provider-Aufruf. Bei fehlender Mikrofonberechtigung den nötigen Freigabeschritt erklären; ohne erhaltene Aufnahme ist ein neuer Aufnahmeversuch nötig. Fehlertexte nutzerverständlich und sicher halten, keine Credentials oder rohe Providerantworten anzeigen. Während Retry Mehrfachklicks verhindern; Erfolg oder bestätigtes Verwerfen räumt den betreffenden Toast auf.

## Verwerfen und Rennen

Verwerfen invalidiert sofort die lokale automatische Übernahme und bricht lokale Aufnahme-/Uploadarbeit soweit möglich ab. Bei vorhandenem Auftrag den autorisierten, idempotenten serverseitigen Discard-Pfad verwenden; der Worker verliert seine Lease beziehungsweise sein Ergebnisrecht und bricht den Provideraufruf soweit möglich ab. Eine bereits bestätigte normale Chat-Audiodatei bleibt erhalten. Der private Snapshot wird nach dem bestehenden Discard-Vertrag freigegeben. Kein Löschen anderer Anhänge und kein Rückgängigmachen eines bereits atomar eingefügten oder gesendeten Entwurfs.

Besonders wichtig: Abort eines HTTP-Uploads beweist nicht, dass der Server keinen Auftrag angelegt hat. Für Abbruch vor Erhalt der Job-ID sowie verlorene Start-Antwort die bestehende Operations-ID nutzen. Vor Umsetzung den kleinsten serverseitig atomaren Vertrag festlegen, der Start und Verwerfen derselben Nutzer-/Chat-/Operations-ID serialisiert und auch ein erst später eintreffendes Start verhindert. Falls nötig einen eng begrenzten Discard-by-operation-Vertrag mit dauerhaftem Abbruchmarker ergänzen; reines clientseitiges Vergessen oder einmaliges Nachschauen genügt nicht. Keine neue Queue oder allgemeine Job-Abstraktion.

Späte HTTP-Antworten, Worker-Ergebnisse und doppelte Live-Events dürfen einen verworfenen Auftrag nicht reaktivieren oder Text einfügen. Abbruchfehler als Fehler mit passendem Retry behandeln, nicht als bestätigten Abbruch darstellen. Ein Rennen mit bereits laufendem Apply entscheidet der atomare Serverzustand: bereits angewandte Ergebnisse nicht nochmals einfügen oder nachträglich Text entfernen. Während die Übernahme bereits festgeschrieben wird, darf die UI keinen garantierten Abbruch mehr versprechen; diese kurze Phase entsprechend nicht abbrechbar darstellen.

## Umsetzung

### 1. Composer-Slot und kompakte Zustände integrieren

`packages/ui/src/chat/ChatComposer.tsx` bietet derzeit `footerTools` links und `contextActions` vor der Kontextanzeige. Einen kleinen generischen Slot unmittelbar vor dem Send-/Stop-Button ergänzen, ohne bestehende Slots umzuordnen. Aufnahmezustände bleiben in `packages/assistant/src/frontend/assistant-dictation.tsx`; Einbindung in `AssistantWorkspace.island.tsx`. Vor Änderungen aktuelle Exporte und alle betroffenen Aufrufer prüfen. Fehlerdarstellung mit Schritt 2 abstimmen; kompakte Wiederherstellung fertiger Diktate erhalten.

### 2. Retry-Toasts und zuverlässiges Verwerfen anbinden

Vorhandene Toasts und Diktat-Dienste verwenden. Operation/Ziel über jeden Callback fest binden, doppelte Fehlerausgabe entfernen, sichere Retry-Schritte und Loader-/Trash-Interaktion umsetzen. Upload-/Start-/Apply-Rennen nach dem obigen Vertrag schließen. Bestehende Composer-Basisrevision, Edit-Generation, Snapshot-Quoten und Live-Invalidierung erhalten. Keine automatische Textüberschreibung.

### 3. Verhalten prüfen und Dokumentation aktualisieren

Fokussierte Zustands-/Diensttests für Retry ohne neue Operation, doppelten Klick, Fehler vor/nach Uploadbestätigung, verlorene Start-Antwort, Cancel-vor-Start-Commit, Cancel nach Providerantwort und Apply/Cancel-Rennen. Prüfen, dass Toast-Schließen Daten und Retry erhält und Navigation keine Aktion auf einen anderen Chat lenkt. Bestehende Audio-/Draft-Tests weiter bestehen lassen.

Browserprüfung: Icon exakt neben Senden, konstante Geometrie, roter Aufnahmezustand, Loader bis Abschluss, Hover/Focus-Trash, Touch-Bedienung, reduzierte Bewegung, Mikrofonfehler, persistenter Toast mit funktionierendem CTA, kompakte explizite Ergebnisübernahme nach Navigation. Chromium und verfügbare Safari/iOS-Geräte prüfen; nicht verfügbare Abnahmen benennen. Canonical Composer-Dokumentation für den neuen Slot sowie Assistant-Hilfe EN/DE aktualisieren. Fokussierte Typechecks und Diff-Prüfung. Echte Providerprüfung bleibt Teil der bereits offenen Audio-Endabnahme.

## Grenzen

Keine Notebook-Änderungen, kein Chunking, keine Meeting-Funktionen, kein Audio-Streaming und keine neue Browser-Persistenz. Der Plan ersetzt die bestehende Audio-Architektur nicht. Commit, Push und Deployment sind separate Schritte.


## Umsetzung und Verifikation

- Generischer `submitTools`-Slot unmittelbar vor Senden/Antwort-Stop; Aufnahme- und Retry-Zustände bleiben im Assistant. Fehler-Menü am Icon erhält Retry/Verwerfen nach geschlossenem Toast.
- Operation-gebundener Discard-Endpunkt und Cancellation-Tabelle, über denselben Conversation-Lock wie Start/Apply serialisiert. Marker bleiben bis zur Conversation-Löschung erhalten. Ein bereits angewandtes Diktat wird nicht rückgängig gemacht; die UI weist darauf hin.
- 40 Chat-Render-/Verhaltenstests, 28 Controller-/Composer-/Recorder-/Live-Tests, drei Hilfetests und acht DB-Diktattests bestanden. DB-Tests umfassen Abbruch vor Start, parallelen Start/Abbruch sowie Apply/Abbruch. Diff-Whitespace und fokussierter Lint bestanden.
- Chrome mit echtem Komponenten-Code, synthetischem Mikrofon und simuliertem Server: Aufnahme/Übernahme, Retry mit identischer Operations-ID, verzögerter Upload plus Abbruch nach Chatwechsel, explizite Übernahme bei Rückkehr, Fehler-Toast ohne doppelte Meldung, manuelles Schließen mit weiter nutzbarem Verwerfen, rote Anzeige, reduzierte Bewegung und Hover-Papierkorb geprüft. Keine Nutzeraufnahmen oder echten Provideraufrufe dafür verwendet.
- UI-Paket-Typecheck bestanden; Cloud/Assistant-Typechecks zeigten bei späteren Läufen ausschließlich Fehler in parallel bearbeiteten Assistant-Artefaktdateien (ArtifactPanel.tsx, client.ts, Workspace.tsx). Diese fremden Änderungen blieben unangetastet. Vorherige Läufe vor diesen Paralleländerungen waren sauber.
- Core und Assistant gebaut und lokal gestartet. Der erste gemeinsame Startlauf wurde durch den anschließenden Assistant-Neustart unterbrochen; beide Dienste wurden danach erneut auf Bereitschaft geprüft.
- Nicht geprüft: Safari/iOS, echter Provider-End-to-End-Lauf und echte WebSocket-Reconnects. Die Provider-/Geräte-Endabnahme bleibt in der bestehenden Audio-Gesamtaufgabe offen. Kein Commit oder Push.

Nach UI-Feedback: Retry-Icon auf 16 px begrenzt; Aufnahme-Kreis durch fünf pegelabhängige Balken ersetzt. RMS-Messung im bestehenden lokalen AudioWorklet, etwa 24 Aktualisierungen pro Sekunde, keine zusätzlichen Audio-Uploads. Browserprüfung mit synthetischem Ton/Stille bestätigt Ausschlag und Rückkehr zur Ruhelage; fünf Recorder-/Hilfetests und Assistant-Typecheck bestanden.


## Folgekorrektur: Aufnahmeleiste und Diagnose

Die Aufnahme ersetzt über `Chat.Composer.footerContent` die Standard-Fußzeile;
der Entwurf bleibt erhalten. Bestätigte Verwerfen-/Übernehmen-Operationen werden
lokal ausgeblendet, bevor die bisherige Statusabfrage aktualisiert wird. Dadurch
kann eine alte fehlgeschlagene Zeile keinen neuen Fehler-Toast erzeugen.

Transkriptionsversuche schreiben sichere Fehlercodes und Meldungen in Logs,
AI-Ausführungen und Traces. Provider-HTTP-Status bleibt erkennbar; Antwortinhalte
werden nicht gespeichert. Diktat-Logs enthalten Auftrag, Modell, Versuch,
Retry-Entscheidung und Trace-ID. Die vom Nutzer korrigierte Cortecs-Basis-URL
lautet `https://api.cortecs.ai/v1`; der Adapter ergänzt den Transkriptionspfad.

Verifiziert: Browserfixture mit echtem Composer und Mikrofon-Worklet, Abbrechen,
Stop und Textübernahme, Verwerfen nach Fehler ohne Reload oder Wiederauftauchen,
mobile Aufnahmeleiste. Ein absichtlicher Provider-404 wurde bis in persistierte
Logs, Trace und AI-Ausführung geprüft. Core neu gestartet und Assistant neu
gebaut; beide bereit. Echte Provider-/Safari-Abnahme bleibt separat offen.
