---
id: grids-publish-custom-app
title: Grids App veröffentlichen
icon: ti ti-rocket
description: Zugriff testen, Capabilities prüfen und einen im Fehlerfall geschlossenen App-Snapshot veröffentlichen.
order: 135
---
Durch die Veröffentlichung wird ein geprüfter Snapshot einer Grids App unter seiner stabilen URL verfügbar. Eine öffentliche App-Freigabe macht nur diesen kompilierten Snapshot öffentlich und öffnet niemals die unmittelbare Basis.

Nur Personen mit Verwaltungsrechten für die Basis können eine Grids App bearbeiten oder veröffentlichen.

## Die veröffentlichte Grenze verstehen {icon="shield-lock"}

Eine aufrufende Person kann eine Ressource nur verwenden, wenn jede zutreffende Grenze sie erlaubt:

| Grenze | Frage |
| --- | --- |
| App-Freigabe | Darf diese Person, Gruppe, angemeldete oder öffentliche aufrufende Stelle die App öffnen? |
| Veröffentlichte Capability | Darf dieser unveränderliche Snapshot genau diese Datenquelle, dieses Feld, Formular, diese Vorlage oder diesen Launcher verwenden? |
| Verfügbarkeit | Gibt die serverseitig ausgeführte `availableWhen`-Abfrage dieser Seite, dieses Blocks, Formulars oder dieser Aktion mindestens eine Zeile zurück? |
| Authentifizierung | Ist die aufrufende Person beim Ausführen einer Workflow-Aktion angemeldet? |

Eine weiter gefasste Berechtigung an einer Grenze überschreibt niemals eine Verweigerung oder engere Grenze an anderer Stelle. Lesende Personen der App benötigen keinen Basiszugriff; er ersetzt auch nicht die App-Freigabe.

Freigaben für Grids Apps unterstützen keine Dienstkonten. Delegierte Anmeldedaten greifen über ihre Personenidentität auf die App zu.

Die App stellt nur Ressourcen bereit, die ihre veröffentlichten Blöcke und Aktionen benennen. Sie gibt weder Arbeitsbereich und Schema der Basis noch parallele Apps oder andere Ressourcen frei. Abgelehnte Blöcke und Aktionen scheitern, ohne ihre Bezeichnungen, Konfiguration oder die Existenz eines referenzierten Datensatzes offenzulegen.

Die Capability-Menge der Veröffentlichung wird aus der App-Definition abgeleitet. Sie listet exakte Ressourcen-IDs und Operationen auf, darunter Formulareingaben, bearbeitbare Datensatzfelder, Dokumentvorlagen und Workflow-Launcher. Builder und `apps plan` zeigen die abgeleitete Menge. Verfassende Personen pflegen keine zweite Capability-Liste von Hand.

## Zielgruppenspezifisches GQL prüfen {icon="filter-lock"}

Wähle die Daten einer Zielgruppe mit der unveränderlichen veröffentlichten Abfrage aus. Eine persönliche Seite für angemeldete Personen kann zum Beispiel `record.createdBy = @auth.id` verwenden; eine anonyme Seite kann `@auth.id = null` prüfen. Diese Filter sind gewöhnliches GQL, das in die App-Capability kompiliert wird, keine verborgenen Berechtigungen für Zeilen der Basis.

Nutze getrennte Apps, wenn öffentliche und angemeldete Zielgruppen unterschiedliche Daten oder Aktionen benötigen. Erstelle keine ACLs pro Seite und verlasse dich bei der Autorisierung nicht auf die Sichtbarkeit der Navigation.

## Vor der Veröffentlichung testen {icon="device-desktop-check"}

Nutze den gespeicherten Entwurf nach Möglichkeit mit eigenen Testkonten. Verwende für öffentliches Verhalten oder fehlenden Zugriff eine bewusst veröffentlichte Test-App, weil der Builder keine andere Zielgruppe nachahmt. Prüfe:

- breite und schmale Bildschirmgrößen;
- das aktuelle Konto und ein gewöhnliches Testkonto;
- die anonyme öffentliche Darstellung und die Darstellung ohne Zugriff in der Testveröffentlichung; beide dürfen keine nicht deklarierten Metadaten preisgeben;
- gültige, fehlende, ungültig formatierte, gelöschte und unzugängliche Seitenparameter;
- leere, ladende, fehlerhafte und erfolgreiche Zustände;
- jede direkte Bearbeitung, Formulareingabe, Dokumentaktion und jeden Workflow-Launcher.

Sowohl die Darstellung des Entwurfs als auch die veröffentlichte Laufzeit erzwingen Capability- und Verfügbarkeitsregeln auf dem Server. Keine der beiden bietet eine Umgehung durch Nachahmung.

## Die Vorabprüfung lesen {icon="list-check"}

Die Vorabprüfung zur Veröffentlichung kompiliert dieselbe typisierte Definition, die Laufzeit und CLI verwenden. Die Veröffentlichung wird blockiert, wenn:

- eine referenzierte Ressource, ein Feld, eine Seite, ein Parameter, eine Vorlage oder ein Launcher fehlt;
- eine Wertreferenz außerhalb ihres Bereichs liegt oder den falschen Typ besitzt;
- der Navigation ein erforderlicher Zielparameter fehlt;
- eine Inline- oder `availableWhen`-Abfrage ungültig oder unbegrenzt ist oder unbekannten Kontext referenziert;
- ein Datensatzblock ein bearbeitbares Feld freigibt, das er nicht anzeigt;
- ein Kommentarblock keinen Seitendatensatz besitzt;
- eine Ressourcenoperation nicht durch die abgeleitete Capability-Menge dargestellt werden kann;
- ein unbekannter Schemaschlüssel oder eine nicht unterstützte Schemaversion vorhanden ist.

Die Vorabprüfung gibt bei ungültigen Definitionen Diagnosen für den jeweiligen Pfad zurück. Der CLI-Plan nennt seine Aktion und konkreten Änderungen; er besitzt keine getrennte Warnungsklasse.

## Einen Snapshot veröffentlichen {icon="copy-check"}

Der Builder speichert Änderungen automatisch in einem Entwurf. Wenn dieser Entwurf von der aktiven Version abweicht, bietet der Hinweis unter Seiten **Änderungen veröffentlichen** und **Aktive Version wiederherstellen** an. Die Veröffentlichung wartet zunächst auf die letzte automatische Speicherung und speichert dann die validierte Definition mit ihrer abgeleiteten Capability-Menge als neuen veröffentlichten Snapshot. Die Wiederherstellung kopiert den aktuellen veröffentlichten Snapshot zurück in den Entwurf. Die stabile Route `/apps/<id>` liefert ausschließlich den veröffentlichten Snapshot.

Veröffentlichte Apps verwenden die referenzierten Grids-Ressourcen weiterhin über ihre unveränderlichen Capabilities. Änderungen an App-Freigaben gelten sofort. Wenn eine referenzierte Ressource später deaktiviert, gelöscht oder inkompatibel geändert wird, schließt die betroffene Seite, der Block oder die Aktion im Fehlerfall. Der Rest der Seite bleibt nutzbar.

Führe die Vorabprüfung nach Änderungen an einer referenzierten Ansicht, einem Formular, einer Vorlage, einem Feld oder Workflow-Launcher erneut aus. Veröffentliche erneut, wenn sich die App-Definition oder die abgeleitete Capability-Menge ändern muss.

## Den veröffentlichten Ablauf prüfen {icon="checks"}

Nach der Veröffentlichung:

:::steps
1. Öffne die stabile URL mit einem gewöhnlichen Konto, nicht nur mit Verwaltungsrechten für die Basis.
2. Durchlaufe jeden primären Ablauf einschließlich Aktualisieren und der Zurück-Funktion des Browsers.
3. Prüfe, dass kopierte Detail-URLs nur deklarierte Parameter enthalten.
4. Probiere eine unzugängliche Datensatz-ID aus und prüfe, dass die Antwort keine Datensatzdetails preisgibt.
5. Prüfe, dass Kommentare seitenweise laden, Datensatzlisten begrenzt bleiben und unabhängige Blöcke getrennt gerendert werden.
6. Ändere den Entwurf und prüfe, dass die veröffentlichte Route bis zur nächsten erfolgreichen Veröffentlichung unverändert bleibt.
:::

Nutze für automatisierte Prüfung und Veröffentlichung [YAML und CLI](/app/grids/help/grids-custom-app-yaml-cli).
