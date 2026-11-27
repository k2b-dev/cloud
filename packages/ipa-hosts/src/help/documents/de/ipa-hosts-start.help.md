---
id: ipa-hosts-start
title: Erste Schritte
icon: ti ti-server
description: FreeIPA-Hostspiegel, Hostgruppen, Synchronisierungsplan und Administrationsaktionen.
order: 100
---

Hosts zeigt einen lokalen Spiegel der FreeIPA-Hosts und Hostgruppen. Personen mit Administratorrechten können den Spiegel synchronisieren und ausgewählte Änderungen an Hosts oder Hostgruppen nach FreeIPA schreiben.

## Überblick {icon="layout-grid"}

:::reference
- **FreeIPA:** FreeIPA ist die maßgebliche Quelle. Die Seite liest aus dem lokalen Spiegel; Änderungen rufen FreeIPA als FreeIPA-Benutzer aus den Anmelde-Einstellungen auf.
- **Hostgruppe:** Eine Hostgruppe gruppiert Hosts anhand ihrer FreeIPA-Mitgliedschaft. Eine geöffnete Hostgruppe nennt ihre Untergruppen, ihre Hosts und wie viele davon keine SSH-Schlüssel haben.
- **Host ohne Gruppe:** Ein gespiegelter Host ohne Hostgruppenmitgliedschaft. Oben auf der Seite steht, wie viele es gibt; der Reiter Ohne Gruppe listet sie.
- **Synchronisierung:** Eine Synchronisierung aktualisiert den lokalen Spiegel aus FreeIPA. Der Zeitplan verwendet einen fünfteiligen Cron-Ausdruck in der konfigurierten Zeitzone.
:::

## Administrationsablauf {icon="route"}

:::reference
- **Hosts und Gruppen finden:** Filtere Hostgruppen und Hosts über das Suchfeld. Die Seitennavigation hält große Spiegel übersichtlich.
- **Fehlende Zuordnungen prüfen:** Die Zahl oben und der Reiter Ohne Gruppe zeigen gespiegelte Hosts ohne Hostgruppe. Die Zeile darunter nennt Hosts ohne SSH-Schlüssel.
- **Host-Metadaten ändern:** Öffne den Host in der Liste. Mit Bearbeiten änderst du Beschreibung, Ort, Standort und MAC-Adressen; unter Hostgruppen fügst du ihn mit Zu Hostgruppe hinzufügen einer Gruppe hinzu oder nimmst ihn mit Entfernen heraus.
- **Hostgruppen pflegen:** Erstelle mit Neue Hostgruppe eine Gruppe. Öffne eine Gruppe in der Liste, um ihre Beschreibung zu bearbeiten oder sie über Weitere Aktionen zu löschen.
- **Synchronisierung starten oder planen:** Unter Weitere Aktionen im Kopf startest du mit Jetzt synchronisieren eine sofortige Aktualisierung oder änderst unter Host-Synchronisierung den wiederkehrenden Cron-Ausdruck.
:::

:::info CLI und Audit-Verlauf
Die `ipa-hosts`-CLI verwendet dieselbe Administrations-API für Listen-, Änderungs-, Mitgliedschafts-, Hostgruppen- und Synchronisierungsbefehle. Schreibaktionen werden protokolliert.
:::
