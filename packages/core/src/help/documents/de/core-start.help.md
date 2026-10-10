---
id: core-start
title: Erste Schritte
icon: ti ti-cloud
description: Profil, Administrationsübersicht, Ankündigungen, Einstellungen, Anmeldung und rechtliche Seiten finden.
order: 100
---

Core stellt die Seiten und Dienste der ganzen Plattform bereit: Anmeldung, Profil, Benachrichtigungen, Administrationsübersicht, globale Einstellungen, Ankündigungen, rechtliche Seiten, Such-APIs und die Seite für unbekannte Adressen. Die Hilfe öffnest du über Profil, Benachrichtigungen, rechtliche Seiten und Administrationsübersicht, bevor du eine Einstellung oder einen Eintrag auswählst.

## Core-Seiten kennen {icon="layout-grid"}

:::reference
- **Profil:** Die Seite `/me` zeigt dein Profil, den Kontodienst, Rollen, Gruppen, Ablaufdaten, API-Schlüssel, Passkeys und deine letzten Kontoaktivitäten.
- **Übersicht:** In der Administration listet die Seite `/admin` die Apps mit Administrationsseiten. Sie zählt außerdem registrierte Apps, verwaltbare Administrationsseiten und Navigationseinträge.
- **Ankündigungen:** Die Administration erstellt Plattformankündigungen und ausblendbare Banner. Jeder Eintrag hat eine Veröffentlichungszeit, eine optionale Ablaufzeit, einen Status und eine Version.
- **Einstellungen:** Die Core-Einstellungen umfassen Branding, Kontolebenszyklus, FreeIPA, KI, Mail, PDF-Erstellung, E-Mail-Vorlagen, Sicherheit und rechtliche Seiten.
:::

## Die richtige Seite finden {icon="route"}

:::reference
- **Eigenes Konto prüfen:** Öffne dein Profil. Es zeigt Kontotyp, Kontodienst, Rollen, Gruppen, Ablaufdaten, Profilfelder, API-Schlüssel, Passkeys und deine letzten Kontoereignisse.
- **Eine Administrationsseite finden:** Öffne die Administrationsübersicht. Sie verlinkt die Administrationsseiten der Apps, etwa Gateway Ops, Konten, IPA Hosts oder App-Einstellungen.
- **Einen Hinweis veröffentlichen:** Nutze **Ankündigungen** für Plattformmeldungen oder Banner im gemeinsamen Layout.
- **Plattformvorgaben ändern:** Nutze die Core-Einstellungen für die globale Dienstkonfiguration. Jede Einstellung stammt aus der Datenbank, der Umgebung oder ihrem Standardwert.
:::

:::info Apps behalten ihre eigene Administration
Core stellt die Plattformseiten und gemeinsamen Dienste bereit. Die Administrationsaufgaben einer App bleiben in dieser App, auch wenn die Core-Administrationsübersicht sie auflistet.
:::
