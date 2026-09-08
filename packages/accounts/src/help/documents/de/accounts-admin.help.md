---
id: accounts-admin
title: Administration
icon: ti ti-settings
description: Personenpflege, Gruppenmitgliedschaften, Dienstkonto-Schlüssel, Benachrichtigungen und Lebenszyklusansichten.
order: 110
---

Die Administrationsseiten sind serverseitig gerenderte Listen mit URL-gestützter Suche, Filtern, Seitennavigation und Aktionsschaltflächen für Kontovorgänge.

Globale Vorgaben und Lifecycle-Nachpflege liegen unter **Administration → Accounts & Anmeldung**.
Nutze **Betrieb** für Lifecycle-Aufträge. Einzelne Datensätze, Anfragen und Historien bleiben hier.
Optionale Hinweise nach erfolgreichen Benutzer-, Gruppen- und Mitgliedschaftsänderungen
konfigurierst du unter **Registrierung & Anfragen**. Eine leere Vorlage zeigt nichts an.
Die Hinweise richten sich an die ausführende Person; sie werden nicht an Nutzer versendet.

## Personen und Gruppen verwalten {icon="user-cog"}

:::reference
- **Personen:** Suche Konten nach UID, Name oder E-Mail-Adresse. Filtere nach Anbieter und Profil und öffne eine Person, um Profilfelder, Avatar, Rollen, Anbieter, Ablaufdatum und Gruppenmitgliedschaften zu bearbeiten.
- **Gruppen:** Öffne eine Gruppe, um Fakten, Mitglieder, verwaltende Personen und übergeordnete Gruppen zu prüfen. Im jeweiligen Verwaltungsbereich lassen sich Personen und Gruppen hinzufügen oder entfernen.
- **Linux-Identitäten:** Bei aktivierter Vergabe unter Administration → Accounts & Anmeldung → Linux-Identitäten erhalten neue lokale Vollaccounts und hochgestufte Gäste ihre Linux-Attribute automatisch. Administratoren können fehlende Attribute älterer Accounts ergänzen und Home und Shell überschreiben. FreeIPA-Werte sind schreibgeschützt. Lokale Gruppen können nach der globalen Einrichtung eine GID erhalten. Diese Aktionen aktivieren weder Rechneranmeldung noch sudo.
- **Gelöschte Konten:** Prüfe Konten, die manuell, durch Ablaufbereinigung, FreeIPA-Rückstufung oder Änderungen am Synchronisierungsbereich entfernt wurden. Die Zeilendetails enthalten weiterhin Metadaten.
- **Erinnerungsverlauf:** Suche Versuche für Kontoablauferinnerungen samt Ablaufdatum, Vorlaufzeit, Status, Versuchen, letztem Versuch und letztem Fehler.
:::

## Zugriff und Nachrichten {icon="shield-lock"}

:::reference
- **Dienstkonten:** Liste aktive oder widerrufene API-Schlüssel auf, filtere nach personen- oder ressourcengebundenen Eigentümern und widerrufe aktive Schlüssel, wenn der Zugriff enden soll.
- **Benachrichtigungen:** Erstelle administrative Benachrichtigungsentwürfe, prüfe die Empfängervorschau, schließe den Batch ab und prüfe Zustellzähler oder fehlgeschlagene Empfänger.
- **Anfragen:** Erstelle Konten aus offenen Anfragen oder lehne Anfragen ab. Eine angegebene Begründung wird per E-Mail versendet. Bestehende Anfragen bleiben verfügbar, wenn neue Anfragen in der Administration deaktiviert werden.
:::

:::info Audit-Verlauf
Konto- und Zugriffsänderungen werden im Audit-Protokoll erfasst. Nutze bei der Untersuchung von API-Schlüssel-Aktivität den Dienstkonto-Filter.
:::
