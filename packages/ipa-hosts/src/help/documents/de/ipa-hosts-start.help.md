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
- **FreeIPA:** FreeIPA ist die maßgebliche Quelle. Die Seite liest aus dem lokalen Spiegel; Änderungen rufen FreeIPA über das Dienstkonto auf.
- **Hostgruppe:** Eine Hostgruppe gruppiert Hosts anhand ihrer FreeIPA-Mitgliedschaft. Verschachtelte Hostgruppen erscheinen als kompakte Badges im Gruppenkopf.
- **Nicht gruppierter Host:** Ein gespiegelter Host ohne Hostgruppenmitgliedschaft. Die Seite zeigt solche Hosts zuerst, weil sie meist zugeordnet werden müssen.
- **Synchronisierung:** Eine Synchronisierung aktualisiert den lokalen Spiegel aus FreeIPA. Der Zeitplan verwendet einen fünfteiligen Cron-Ausdruck in der konfigurierten Zeitzone.
:::

## Administrationsablauf {icon="route"}

:::reference
- **Hosts und Gruppen finden:** Filtere Hostgruppen und Hosts über das Suchfeld. Die Seitennavigation hält große Spiegel übersichtlich.
- **Fehlende Zuordnungen prüfen:** Kennzahl und Abschnitt Nicht gruppiert zeigen gespiegelte Hosts ohne Hostgruppe.
- **Host-Metadaten ändern:** Bearbeite über das Aktionsmenü einer Host-Zeile Beschreibung, Ort, Standort, MAC-Adressen oder Hostgruppenmitgliedschaft.
- **Hostgruppen pflegen:** Erstelle Hostgruppen, bearbeite Beschreibungen oder lösche nicht mehr benötigte Gruppen über die Hostgruppen-Karten.
- **Synchronisierung starten oder planen:** Starte mit Jetzt synchronisieren eine sofortige Aktualisierung oder ändere unter Einstellungen den wiederkehrenden Cron-Ausdruck.
:::

:::info CLI und Audit-Verlauf
Die `ipa-hosts`-CLI verwendet dieselbe Administrations-API für Listen-, Änderungs-, Mitgliedschafts-, Hostgruppen- und Synchronisierungsbefehle. Schreibaktionen werden protokolliert.
:::
