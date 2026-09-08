---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Agententaugliche Befehle für Konten, Gruppen, Anfragen, Audit und Dienstkonten.
order: 120
---

Die Accounts-CLI verwendet dieselben APIs wie die App. Agenten können Kontodaten deshalb ohne Browser auflisten, prüfen und ändern. Linux-Identitäten verwenden die eigene API mit Administratorprüfung.

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

## Linux-Identitäten

Prüfe mit `cld accounts users linux get <user> --json` die Identität. Nach der
globalen Einrichtung bereitet `users linux prepare <user> --yes` einen lokalen
Vollaccount vor. Beide Pfade setzt du mit
`users linux update <user> --home /home/alice --shell /bin/bash --yes`.
`cld accounts groups make-posix <group> --yes` unterstützt lokale und FreeIPA-Gruppen.

Globale Konfiguration und seitenweise Vorschau liegen unter `cld admin linux`.
Exportiere die Konfiguration mit `config get --json`. Eine aktivierte
Konfiguration übernimmst du mit
`config set --config-file ./linux.json --range-reserved --yes`.
Die Vorbereitung aktiviert weder Computeranmeldung noch sudo oder gemeinsamen Speicher.
