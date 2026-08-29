---
id: accounts-lifecycle
title: Zugriffslebenszyklus
icon: ti ti-user-shield
description: Direkte und geerbte Gruppen, Kontoablauf, Anfragen, Dienstkonten und sichere Zugriffsänderungen verstehen.
order: 115
---

Accounts verbindet Identitätseinträge mit den Zugriffen von Personen und Integrationen. Prüfe vor einer Änderung an einer Person oder Gruppe den aktuellen Anbieter und den Gruppenpfad.

## Zugriff richtig lesen {icon="shield-lock"}

- **Direkte Mitgliedschaft** ist unmittelbar an der Person oder Gruppe gespeichert.
- **Indirekte Mitgliedschaft** entsteht durch verschachtelte über- oder untergeordnete Gruppen. Mit der Einstellung Nur direkt unterscheidest du gespeicherte Mitgliedschaften vom wirksamen Zugriff.
- **Verwaltende Personen** dürfen Gruppen innerhalb ihres Verwaltungsbereichs pflegen. Das ist etwas anderes als eine bloße Gruppenmitgliedschaft.
- **Dienstkonto-Mitgliedschaften** sind in normalen Mitgliederlisten verborgen, bis du ihre Anzeige aktivierst.
- **Anbieter-Badges** unterscheiden lokale Einträge von FreeIPA-gestützten Einträgen und weiteren konfigurierten Profilen.

## Typischer Lebenszyklus {icon="user-cog"}

:::steps
1. Prüfe oder genehmige eine Kontoanfrage.
2. Erstelle das Konto mit dem vorgesehenen Anbieter und Profil.
3. Füge nur die für die Rolle erforderlichen direkten Gruppen hinzu.
4. Prüfe den wirksamen Gruppenzugriff und den Verwaltungsbereich in den Konto- oder Gruppendetails.
5. Lege bei zeitlich begrenztem Zugriff ein Ablaufdatum fest oder prüfe es.
6. Nutze Erinnerungs- und Löschverlauf, um Änderungen im Lebenszyklus zu untersuchen.
:::

## Dienstkonto-Schlüssel {icon="point"}

- Ein **personengebundener** Schlüssel handelt innerhalb der wirksamen Zugriffe seines Eigentümers.
- Ein **ressourcengebundener** Schlüssel ist auf die Ressource der besitzenden App begrenzt.
- Ein Widerruf beendet die künftige Verwendung des Schlüssels; der Eintrag bleibt für den Audit-Verlauf erhalten.
- Kopiere einen Schlüssel niemals in Tickets, Chatnachrichten, Screenshots oder Dokumentation.

:::warning Vor dem Entfernen geerbten Zugriff prüfen
Das Entfernen einer direkten Mitgliedschaft garantiert nicht, dass der wirksame Zugriff verschwindet. Dieselbe Person oder Gruppe kann den Zugriff weiterhin über einen anderen Gruppenpfad erben.
:::

## Wenn das Ergebnis unerwartet ist {icon="lifebuoy"}

- Wechsle zwischen der Ansicht Nur direkt und allen Mitgliedschaften.
- Zeige Dienstkonto-Mitgliedschaften an, wenn Tabellenzähler und sichtbare Personen voneinander abweichen.
- Prüfe vor einem erneuten Schreibversuch den Anbieter des Eintrags.
- Öffne das Audit-Protokoll und filtere nach handelnder Person, Ziel, Aktion oder Dienstkonto.
- Prüfe Lösch- oder Erinnerungsverlauf, wenn das Konto durch Ablauf oder Synchronisierung geändert wurde.
