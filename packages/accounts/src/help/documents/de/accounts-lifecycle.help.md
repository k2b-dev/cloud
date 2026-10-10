---
id: accounts-lifecycle
title: Zugriffslebenszyklus
icon: ti ti-user-shield
description: Direkte und geerbte Gruppen lesen, Kontoablauf festlegen, Anfragen bearbeiten, Dienstkonten nutzen und Zugriff sicher ändern.
order: 115
---

Konten verbindet Identitätseinträge mit dem Zugriff, den Personen und Integrationen erhalten. Prüfe vor einer Änderung an einer Person oder Gruppe den aktuellen Anbieter und den Gruppenpfad.

## Direkten und geerbten Zugriff unterscheiden {icon="shield-lock"}

- **Direkte Mitgliedschaft** ist an der Person oder Gruppe selbst gespeichert.
- **Indirekte Mitgliedschaft** entsteht durch verschachtelte über- oder untergeordnete Gruppen. Mit **Nur direkte** unterscheidest du gespeicherte Mitgliedschaften vom wirksamen Zugriff.
- **Verantwortliche** pflegen die Gruppen in ihrem Verwaltungsbereich. Eine Gruppe zu verwalten ist etwas anderes, als Mitglied zu sein.
- **Mitgliedschaften von Dienstkonten** sind in normalen Mitgliederlisten verborgen, bis du **Mitgliedschaften von Dienstkonten anzeigen** wählst.
- **Anbieter-Badges** unterscheiden lokale Einträge von FreeIPA-gestützten Einträgen und weiteren konfigurierten Profilen.

:::warning Prüfe geerbten Zugriff, bevor du eine Mitgliedschaft entfernst
Das Entfernen einer direkten Mitgliedschaft garantiert nicht, dass der wirksame Zugriff endet. Dieselbe Person oder Gruppe kann den Zugriff weiter über einen anderen Gruppenpfad erben.
:::

## Zugriff für eine Rolle geben {icon="user-cog"}

:::steps
1. Prüfe oder genehmige eine Kontoanfrage.
2. Erstelle das Konto mit dem vorgesehenen Anbieter und Profil.
3. Füge nur die direkten Gruppen hinzu, die die Rolle braucht.
4. Prüfe in den Konto- oder Gruppendetails den wirksamen Gruppenzugriff und den Verwaltungsbereich.
5. Ist der Zugriff befristet, lege ein Ablaufdatum fest oder prüfe es.
6. Nutze Erinnerungsverlauf und Löschverlauf, um Änderungen im Lebenszyklus zu untersuchen.
:::

## Dienstkonto-Schlüssel nutzen {icon="point"}

- Ein **personengebundener** Schlüssel handelt für seinen Eigentümer, innerhalb von dessen wirksamem Zugriff.
- Ein **ressourcengebundener** Schlüssel ist auf die Ressource der App begrenzt, der er gehört.
- Ein Widerruf beendet jede künftige Verwendung des Schlüssels. Der Eintrag bleibt für den Audit-Verlauf erhalten.
- Kopiere einen Schlüssel nie in Tickets, Chatnachrichten, Screenshots oder Dokumentation.

## Unerwartete Ergebnisse klären {icon="lifebuoy"}

- Wechsle zwischen **Nur direkte** und der Ansicht aller Mitgliedschaften.
- Wähle **Mitgliedschaften von Dienstkonten anzeigen**, wenn Tabellenzähler und sichtbare Personen voneinander abweichen.
- Prüfe den Anbieter des Eintrags, bevor du einen Schreibvorgang wiederholst.
- Öffne das **Audit-Protokoll** und filtere nach handelnder Person, Ziel, Aktion oder Dienstkonto.
- Prüfe Löschverlauf oder Erinnerungsverlauf, wenn sich das Konto durch Ablauf oder Synchronisierung geändert hat.
