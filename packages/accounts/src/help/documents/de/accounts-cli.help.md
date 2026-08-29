---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Agententaugliche Befehle für Konten, Gruppen, Anfragen, Audit und Dienstkonten.
order: 120
---

Die Accounts-CLI verwendet dieselbe `/api/accounts`-API wie die App. Agenten können Kontodaten deshalb ohne Browser auflisten, prüfen und ändern.

## Befehlsgruppen {icon="code"}

:::reference
- **users:** Personen auflisten, prüfen, erstellen, ändern und löschen; Anbieter, Profil und Administrationsstatus ändern; Avatare verwalten; IPA-Passwörter zurücksetzen und Anmeldelinks senden.
- **groups:** Gruppen auflisten, prüfen, erstellen, ändern, in POSIX-Gruppen umwandeln und löschen sowie Mitglieder und verwaltende Personen pflegen.
- **requests:** Kontoanfragen auflisten, prüfen und ablehnen.
- **audit:** Audit-Ereignisse nach handelnder Person, Ziel, Aktion, Aktionsgruppe, Dienstkonto, Ergebnis, Anbieter und Zeitraum auflisten.
- **service-accounts:** API-Schlüssel von Dienstkonten auflisten und aktive Zugangsdaten widerrufen.
:::

:::info Ausgabeformat
Nutze für Automatisierung die JSON-Ausgabe. Die Tabellenausgabe dient der schnellen Prüfung im Terminal.
:::
