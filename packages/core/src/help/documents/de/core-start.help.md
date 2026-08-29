---
id: core-start
title: Erste Schritte
icon: ti ti-cloud
description: Profil-Selbstverwaltung, Plattformadministration, Ankündigungen, Einstellungen, Anmeldung und rechtliche Seiten.
order: 100
---

Core besitzt die plattformweiten Seiten und Dienste: Anmeldung, Profil-Selbstverwaltung, Benachrichtigungen, Administrationsübersicht, globale Einstellungen, Ankündigungen, rechtliche Seiten, Such-APIs und die oberste Routing-Rückfallseite. Die Hilfe ist über Profil, Benachrichtigungen, rechtliche Seiten und Administrationsübersicht verfügbar, bevor du eine bestimmte Einstellung oder einen Eintrag auswählst.

## Überblick {icon="layout-grid"}

:::reference
- **Profil:** Die Seite `/me` zeigt Profil, Anbieter, Rollen, Gruppen, Ablaufdaten, API-Schlüssel, Passkeys und letzte Kontoaktivitäten der angemeldeten Person.
- **Administrationsübersicht:** Die Seite `/admin` listet Apps mit Administrationsbereichen und fasst registrierte Apps, verwaltbare Bereiche und Navigationseinträge zusammen.
- **Ankündigungen:** Personen mit Administratorrechten können Plattformankündigungen und ausblendbare Banner mit Veröffentlichungszeit, Ablaufzeit, Status und Versionsmetadaten erstellen.
- **Einstellungen:** Core-Einstellungen decken Branding, Benutzerlebenszyklus, FreeIPA, AI, Mail, PDF-Rendering, E-Mail-Vorlagen, Sicherheit und rechtliche Seiten ab.
:::

## Häufige Wege {icon="route"}

:::reference
- **Eigenes Konto prüfen:** Öffne Profil, um Kontotyp, Anbieter, Rollen, Gruppen, Ablaufdaten, Profilfelder, API-Schlüssel, Passkeys und letzte Kontoereignisse zu sehen.
- **Einen Administrationsbereich finden:** Öffne die Administrationsübersicht, um zu app-eigenen Bereichen wie Gateway Ops, Accounts, IPA Hosts oder App-Einstellungen zu wechseln.
- **Einen Hinweis veröffentlichen:** Nutze Ankündigungen für Plattformmeldungen oder Banner im gemeinsamen Layout.
- **Plattformvorgaben ändern:** Nutze Core-Einstellungen für die globale Dienstkonfiguration. Einstellungen werden aus Datenbank, Umgebung und Vorgaben aufgelöst.
:::

:::info Grenze
Core besitzt Plattformseiten und gemeinsame Dienste. App-spezifische Administrationsabläufe bleiben bei der besitzenden App, auch wenn sie in der Core-Administrationsübersicht erscheinen.
:::
