---
id: accounts-admin
title: Administration
icon: ti ti-settings
description: Personenpflege, Gruppenmitgliedschaften, Dienstkonto-Schlüssel, Benachrichtigungen und Lebenszyklusansichten.
order: 110
---

Die Administrationsseiten sind serverseitig gerenderte Listen mit URL-gestützter Suche, Filtern, Seitennavigation und Aktionsschaltflächen für Kontovorgänge.

## Personen und Gruppen verwalten {icon="user-cog"}

:::reference
- **Personen:** Suche Konten nach UID, Name oder E-Mail-Adresse. Filtere nach Anbieter und Profil und öffne eine Person, um Profilfelder, Avatar, Rollen, Anbieter, Ablaufdatum und Gruppenmitgliedschaften zu bearbeiten.
- **Gruppen:** Öffne eine Gruppe, um Fakten, Mitglieder, verwaltende Personen und übergeordnete Gruppen zu prüfen. Im jeweiligen Verwaltungsbereich lassen sich Personen und Gruppen hinzufügen oder entfernen.
- **Linux-Identitäten:** Bei aktivierter Vergabe unter Administration → Einstellungen → Linux-Zugang erhalten neue lokale Vollaccounts und hochgestufte Gäste ihre Linux-Attribute automatisch. Administratoren können fehlende Attribute älterer Accounts ergänzen und Home und Shell überschreiben. FreeIPA-Werte sind schreibgeschützt. Lokale Gruppen können nach der globalen Einrichtung eine GID erhalten. Diese Aktionen aktivieren weder Rechneranmeldung noch sudo.
- **Gelöschte Konten:** Prüfe Konten, die manuell, durch Ablaufbereinigung, FreeIPA-Rückstufung oder Änderungen am Synchronisierungsbereich entfernt wurden. Die Zeilendetails enthalten weiterhin Metadaten.
- **Erinnerungsverlauf:** Suche Versuche für Kontoablauferinnerungen samt Ablaufdatum, Vorlaufzeit, Status, Versuchen, letztem Versuch und letztem Fehler.
:::

## Zugriff und Nachrichten {icon="shield-lock"}

:::reference
- **Dienstkonten:** Liste aktive oder widerrufene API-Schlüssel auf, filtere nach personen- oder ressourcengebundenen Eigentümern und widerrufe aktive Schlüssel, wenn der Zugriff enden soll.
- **Benachrichtigungen:** Erstelle administrative Benachrichtigungsentwürfe, prüfe die Empfängervorschau, schließe den Batch ab und prüfe Zustellzähler oder fehlgeschlagene Empfänger.
- **Anfragen:** Erstelle Konten aus offenen Anfragen oder lehne Anfragen ab. Eine angegebene Begründung wird per E-Mail versendet.
:::

:::info Audit-Verlauf
Konto- und Zugriffsänderungen werden im Audit-Protokoll erfasst. Nutze bei der Untersuchung von API-Schlüssel-Aktivität den Dienstkonto-Filter.
:::
