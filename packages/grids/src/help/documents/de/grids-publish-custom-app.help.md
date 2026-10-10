---
id: grids-publish-custom-app
title: Grids App veröffentlichen
icon: ti ti-rocket
description: Teste den Zugriff, prüfe Capabilities und veröffentliche einen App-Snapshot, der im Fehlerfall sperrt.
order: 135
---
Die Veröffentlichung macht einen geprüften Snapshot einer Grids App unter ihrer stabilen URL verfügbar. Öffentlicher Zugriff auf eine App macht nur diesen kompilierten Snapshot öffentlich. Die Base mit ihren Rohdaten öffnet er nie.

Zum Bearbeiten oder Veröffentlichen einer Grids App brauchst du Zugriff **Verwalten** auf die Base.

## Die veröffentlichte Grenze verstehen {icon="shield-lock"}

Eine aufrufende Person kann eine Ressource nur verwenden, wenn jede zutreffende Grenze sie erlaubt:

| Grenze | Frage |
| --- | --- |
| Zugriff auf die App | Darf diese Person, Gruppe, angemeldete oder öffentliche aufrufende Stelle die App öffnen? |
| Veröffentlichte Capability | Darf dieser unveränderliche Snapshot genau diese Datenquelle, dieses Feld, dieses Formular, diese Vorlage oder diesen Launcher verwenden? |
| Verfügbarkeit | Liefert die serverseitige `availableWhen`-Abfrage dieser Seite, dieses Blocks, Formulars oder dieser Aktion mindestens eine Zeile? |
| Authentifizierung | Ist die aufrufende Person angemeldet, wenn sie eine Workflow-Aktion ausführt? |

Weiterer Zugriff an einer Grenze überschreibt nie eine Ablehnung oder eine engere Grenze an anderer Stelle. Personen, die die App verwenden, brauchen keinen Zugriff auf die Base. Zugriff auf die Base ersetzt nicht den Zugriff auf die App.

Grids Apps nehmen keine Dienstkonten an. Delegierte Anmeldedaten öffnen die App über die Identität ihrer Person.

Die App stellt nur die Ressourcen bereit, die ihre veröffentlichten Blöcke und Aktionen nennen. Sie gibt weder Arbeitsbereich noch Schema der Base frei, keine anderen Apps und keine fremden Ressourcen. Abgelehnte Blöcke und Aktionen scheitern, ohne ihre Bezeichnungen, ihre Konfiguration oder die Existenz eines referenzierten Datensatzes preiszugeben.

Grids leitet die Capability-Menge einer Veröffentlichung aus der App-Definition ab. Sie listet exakte Ressourcen-IDs und Vorgänge auf, darunter Formulareingaben, bearbeitbare Datensatzfelder, Dokumentvorlagen und Workflow-Launcher. Builder und `apps plan` zeigen die abgeleitete Menge. Wer die App erstellt, pflegt keine zweite Capability-Liste von Hand.

## GQL für jede Zielgruppe prüfen {icon="filter-lock"}

Wähle die Daten einer Zielgruppe mit der unveränderlichen veröffentlichten Abfrage aus. Eine persönliche Seite für angemeldete Personen kann zum Beispiel `record.createdBy = @auth.id` verwenden. Eine anonyme Seite kann `@auth.id = null` prüfen. Diese Filter sind normales GQL, das in die App-Capability kompiliert wird. Sie sind kein verborgener Zugriff auf Zeilen der Base.

Nutze getrennte Apps, wenn öffentliche und angemeldete Zielgruppen unterschiedliche Daten oder Aktionen brauchen. Baue keine Zugriffslisten pro Seite. Verlasse dich bei der Autorisierung nicht auf die Sichtbarkeit der Navigation.

## Vor der Veröffentlichung testen {icon="device-desktop-check"}

Nutze den gespeicherten Entwurf möglichst mit eigenen Testkonten. Der Builder kann nicht als andere Zielgruppe auftreten. Um öffentliches Verhalten oder fehlenden Zugriff zu testen, veröffentliche bewusst eine Test-App. Prüfe:

- breite und schmale Bildschirme;
- das aktuelle Konto und ein gewöhnliches Testkonto;
- die anonyme öffentliche Darstellung und die Darstellung ohne Zugriff in der Testveröffentlichung; keine von beiden darf nicht deklarierte Metadaten preisgeben;
- gültige, fehlende, falsch formatierte, gelöschte und unzugängliche Seitenparameter;
- leere, ladende, fehlerhafte und erfolgreiche Zustände;
- jede direkte Bearbeitung, jede Formulareingabe, jede Dokumentaktion und jeden Workflow-Launcher.

Die Darstellung des Entwurfs und die veröffentlichte Laufzeit setzen Capability- und Verfügbarkeitsregeln beide auf dem Server durch. Keine von beiden lässt sich umgehen, indem man als jemand anderes auftritt.

## Die Vorabprüfung lesen {icon="list-check"}

Die Vorabprüfung kompiliert dieselbe typisierte Definition, die Laufzeit und CLI verwenden. Sie blockiert die Veröffentlichung, wenn:

- eine referenzierte Ressource, ein Feld, eine Seite, ein Parameter, eine Vorlage oder ein Launcher fehlt;
- eine Wertreferenz außerhalb ihres Bereichs liegt oder den falschen Typ hat;
- der Navigation ein erforderlicher Zielparameter fehlt;
- eine Inline- oder `availableWhen`-Abfrage ungültig oder unbegrenzt ist oder unbekannten Kontext referenziert;
- ein Datensatzblock ein bearbeitbares Feld bereitstellt, das er nicht anzeigt;
- ein Kommentarblock keinen Seitendatensatz hat;
- die abgeleitete Capability-Menge einen Ressourcenvorgang nicht abbilden kann;
- ein unbekannter Schemaschlüssel oder eine nicht unterstützte Schemaversion vorkommt.

Bei einer ungültigen Definition liefert die Vorabprüfung Diagnosen je Pfad. Der CLI-Plan nennt seine Aktion und die konkreten Änderungen. Eine eigene Warnungsklasse hat er nicht.

## Einen Snapshot veröffentlichen {icon="copy-check"}

Der Builder speichert Änderungen automatisch in einem Entwurf. Weicht der Entwurf von der veröffentlichten Version ab, bietet der Hinweis unter **Seiten** die Optionen **Änderungen veröffentlichen** und **Veröffentlichte Version wiederherstellen** an.

- **Änderungen veröffentlichen** wartet zuerst auf die letzte automatische Speicherung. Danach speichert es die validierte Definition mit ihrer abgeleiteten Capability-Menge als neuen veröffentlichten Snapshot.
- **Veröffentlichte Version wiederherstellen** kopiert den aktuellen veröffentlichten Snapshot zurück in den Entwurf.

Die stabile Route `/apps/<id>` liefert nur den veröffentlichten Snapshot.

Eine veröffentlichte App verwendet die referenzierten Grids-Ressourcen weiter über ihre unveränderlichen Capabilities. Änderungen am Zugriff auf die App gelten sofort. Deaktiviert oder löscht jemand später eine referenzierte Ressource oder ändert sie inkompatibel, sperrt die betroffene Seite, der Block oder die Aktion. Der Rest der Seite bleibt nutzbar.

### Nach einer Änderung an einer verwendeten Ressource erneut veröffentlichen

Eine Änderung an einer referenzierten Ansicht, einem Formular, einer Vorlage, einem Feld oder einem Workflow kann ändern, was die veröffentlichte App lesen, schreiben oder starten darf. Dann bietet der Builder **Änderungen veröffentlichen** an, auch wenn die App-Definition unverändert ist. Hat der Entwurf keine weiteren Änderungen, lautet der Hinweis **Verwendete Ressourcen wurden geändert**.

Macht die Änderung den Entwurf ungültig, etwa weil jemand ein Formular deaktiviert hat, nennt **Entwurf prüfen** den betroffenen Teil. Behebe ihn vor der Veröffentlichung. Bis du erneut veröffentlichst, behält die veröffentlichte App ihre zuletzt geprüften Capabilities. Betroffene Teile können deshalb nicht verfügbar bleiben. Die Veröffentlichung leitet die Capability-Menge aus den aktuellen Ressourcen ab.

`cld grids apps get` meldet diesen Zustand als `used resources changed: yes`. Eine Änderung, die diese Capabilities nicht berührt, etwa eine neue Formularbeschriftung, erreicht die veröffentlichte App sofort.

## Den veröffentlichten Ablauf prüfen {icon="checks"}

Nach der Veröffentlichung:

:::steps
1. Öffne die stabile URL mit einem gewöhnlichen Konto, nicht nur mit Zugriff **Verwalten** auf die Base.
2. Durchlaufe jeden wichtigen Ablauf, auch mit Neuladen und der Zurück-Schaltfläche des Browsers.
3. Prüfe, dass kopierte Detail-URLs nur deklarierte Parameter behalten.
4. Probiere eine unzugängliche Datensatz-ID aus. Prüfe, dass die Antwort keine Datensatzdetails preisgibt.
5. Prüfe, dass Kommentare seitenweise laden und Datensatzlisten begrenzt bleiben.
6. Prüfe, dass unabhängige Blöcke getrennt gerendert werden.
7. Ändere den Entwurf. Prüfe, dass die veröffentlichte Route bis zur nächsten erfolgreichen Veröffentlichung unverändert bleibt.
:::

Für automatisierte Prüfung und Veröffentlichung nutze [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli).
