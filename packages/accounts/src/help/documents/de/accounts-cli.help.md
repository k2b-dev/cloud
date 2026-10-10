---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Agententaugliche Befehle für Konten, Gruppen, Anfragen, Audit-Ereignisse und Dienstkonten nutzen.
order: 120
---

Die Konten-CLI nutzt dieselben APIs wie die App. Agenten können Kontodaten deshalb ohne Browser auflisten, prüfen und ändern. Linux-Identitäten nutzen eine eigene API, die nur die Administration aufrufen kann.

## Die richtige Befehlsgruppe finden {icon="code"}

:::reference
- **users:** Personen auflisten, prüfen, erstellen, ändern und löschen. Anbieter, Profil und Administrationsstatus ändern. Avatare lesen, setzen und entfernen, IPA-Passwörter zurücksetzen, mit `users login-token` ein **Anmeldetoken** erstellen und mit `users send-login-link` einen Anmeldelink senden. Erlaubt die Installation lokale Konten ohne E-Mail-Adresse, erstellt `users create` ein lokales Vollkonto auch ohne `--email`, und `users update --remove-email` entfernt eine Adresse.
- **groups:** Gruppen auflisten, prüfen, erstellen, ändern, in POSIX-Gruppen umwandeln und löschen. Mitglieder und Verantwortliche auflisten, hinzufügen und entfernen.
- **requests:** Kontoanfragen auflisten, prüfen und ablehnen.
- **audit:** Audit-Ereignisse auflisten, gefiltert nach handelnder Person, Ziel, Aktion, Aktionsgruppe, Dienstkonto, Ergebnis, Anbieter und Zeitraum.
- **service-accounts:** API-Schlüssel von Dienstkonten auflisten und aktive Zugangsdaten widerrufen.
:::

:::info Ausgabeformat wählen
Nutze für Automatisierung die JSON-Ausgabe. Die Tabellenausgabe dient dem schnellen Blick im Terminal.
:::

## Linux-Identitäten vorbereiten {icon="terminal"}

- Prüfe eine Identität mit `cld accounts users linux get <user> --json`.
- Nach der globalen Einrichtung ergänzt `users linux prepare <user> --yes` fehlende Attribute eines bestehenden lokalen Vollkontos. Bei eingeschalteter Vergabe erhalten neue lokale Vollkonten und hochgestufte Gäste diese Attribute automatisch.
- `users linux update <user> --home /home/alice --shell /bin/bash --yes` setzt beide Pfade.
- `cld accounts groups make-posix <group> --yes` funktioniert für lokale und FreeIPA-Gruppen.

`cld admin linux` enthält die globale Konfiguration und eine seitenweise Vorschau. Exportiere die Konfiguration mit `config get --json`. Wende eine aktivierte Konfiguration mit `config set --config-file ./linux.json --range-reserved --yes` an. Das Vorbereiten einer Identität schaltet weder die Anmeldung am Rechner noch sudo oder gemeinsamen Speicher frei.

Um eine lokale Gruppe mit GID in einem Schritt zu erstellen, führe `cld accounts groups create team --provider local --posix` aus. Ohne `--posix` bleibt sie eine logische Gruppe. Das Erstellen oder Umwandeln einer lokalen POSIX-Gruppe setzt eingeschaltete lokale Linux-Identitäten voraus. Schlägt einer der beiden Vorgänge fehl, bleibt keine teilweise erstellte Gruppe zurück.
