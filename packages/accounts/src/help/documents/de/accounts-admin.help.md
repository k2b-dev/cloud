---
id: accounts-admin
title: Administration
icon: ti ti-settings
description: Personen und Gruppen pflegen, doppelte Adressen bereinigen, Schlüssel und Geräte widerrufen, Benachrichtigungen senden und den Lebenszyklus prüfen.
order: 110
---

Die Administrationsseiten sind serverseitig gerenderte Listen. Suche, Filter und Seitennavigation stehen in der URL, und Aktionsschaltflächen führen die Kontovorgänge aus.

Globale Vorgaben und die Nachpflege des Lebenszyklus liegen in der Cloud-Administration unter **Accounts & Anmeldung**. Starte Lebenszyklus-Aufträge über **Betrieb**. Einzelne Datensätze, Anfragen und Verläufe bleiben hier in Konten.

Unter **Registrierung & Anfragen** kannst du optionale Hinweise zur Nacharbeit festlegen, die von der Aktion abhängen. Sie erscheinen nach erfolgreichen Änderungen an Personen, Gruppen und Mitgliedschaften. Eine leere Vorlage zeigt nichts an. Ein Hinweis richtet sich an die Person, die die Änderung ausführt. Cloud versendet ihn nicht an die Betroffenen.

## Doppelte E-Mail-Adressen bereinigen {icon="users"}

Öffne **Administration → Doppelte E-Mail-Adressen**, um Konten mit derselben Adresse zu vergleichen. Der Vergleich ignoriert Groß- und Kleinschreibung sowie Leerzeichen am Anfang und Ende.

Jedes Konto zeigt seine letzte Cloud-Web-Anmeldung. FreeIPA-Konten zeigen außerdem die letzte Kerberos-Anmeldung und den Zeitpunkt der Synchronisierung. Kerberos-Aktivität kann Nutzung außerhalb von Cloud enthalten. Alle Uhrzeiten sind in UTC. **Nicht erfasst** bedeutet nicht, dass niemand das Konto je benutzt hat.

:::warning Das Löschen eines FreeIPA-Kontos löscht auch den Benutzer in FreeIPA
Konten überträgt weder Daten noch Zugriff auf das verbleibende Konto.
:::

:::steps
1. Öffne ein Konto und prüfe seinen Zugriff.
2. Lösche das Konto.
3. Bestätige jede Löschung einzeln.
:::

Bereinigte Adressen verschwinden aus der Liste. Dein eigenes Konto kannst du nicht löschen.

## Personen und Gruppen pflegen {icon="user-cog"}

:::reference
- **Benutzer:** Suche Konten nach UID, Name oder E-Mail-Adresse. Filtere nach Anbieter und Profil. Öffne eine Person, um Profilfelder, Avatar, Rollen, Anbieter, Ablaufdatum und Gruppenmitgliedschaften zu bearbeiten.
- **Gruppen:** Öffne eine Gruppe, um ihre Angaben, Mitglieder, Verantwortlichen und übergeordneten Gruppen zu prüfen. Verantwortliche können Personen und Gruppen hinzufügen oder entfernen, wo die Seite diese Änderungen anbietet.
- **Linux-Identitäten:** Ist die Vergabe in der Cloud-Administration unter **Accounts & Anmeldung → Linux-Identitäten** eingeschaltet, erhalten neue lokale Vollkonten und hochgestufte Gäste ihre Linux-Attribute automatisch. Die Administration kann fehlende Attribute älterer Konten ergänzen und Home und Shell überschreiben. FreeIPA-Werte sind schreibgeschützt. Lokale Gruppen können nach der globalen Einrichtung eine GID erhalten. Diese Aktionen schalten weder die Anmeldung am Rechner noch sudo frei.
- **Gelöschte Konten:** Prüfe Konten, die durch eine manuelle Aktion, eine Ablaufbereinigung, eine FreeIPA-Rückstufung oder eine Änderung des Synchronisierungsbereichs entfernt wurden. Die Zeilendetails enthalten weiterhin ihre Metadaten.
- **Erinnerungsverlauf:** Durchsuche die Versuche, Erinnerungen zum Kontoablauf zu senden. Jeder Eintrag zeigt Ablaufdatum, Vorlaufzeit in Tagen, Status, Anzahl der Versuche, letzten Versuch und letzten Fehler.
:::

## Konto ohne E-Mail-Adresse führen {icon="user-cog"}

Ist **Lokale Konten ohne E-Mail-Adresse erlauben** in der Cloud-Administration eingeschaltet, kannst du ein **Login**-Konto ohne Adresse anlegen. Um die Adresse eines bestehenden Kontos zu entfernen, leere das Feld und bestätige. Die Person meldet sich dann mit einer gekoppelten App oder einem Passkey an. Aktionen, die E-Mail brauchen, etwa **Benachrichtigen**, blendet Konten für diese Konten aus.

Für die erste Anmeldung hast du zwei Möglichkeiten:

- Gib ein einmaliges **Anmeldetoken** weiter.
- Kopple das erste Gerät der Person mit **Anmelde-App koppeln**, wenn **Administratoren dürfen bei der Kopplung helfen** eingeschaltet ist.

Verliert die Person ihr einziges Gerät:

:::steps
1. Widerrufe das Gerät unter **Anmeldegeräte**.
2. Gib der Person ein neues **Anmeldetoken**.
:::

Die Person kann sich dann anmelden und erneut ein Gerät koppeln.

## Schlüssel, Geräte, Benachrichtigungen und Anfragen steuern {icon="shield-lock"}

:::reference
- **Dienstkonten:** Liste aktive oder widerrufene API-Schlüssel auf und filtere nach personen- oder ressourcengebundenen Eigentümern. Widerrufe einen aktiven Schlüssel, wenn sein Zugriff enden muss.
- **Anmeldegeräte:** Die Seite einer Person zeigt die Geräte, die ihre App-Anmeldungen bestätigen, mit Kopplungsdatum und letzter Verwendung. Widerrufe dort ein verlorenes Gerät. Bestehende Sitzungen bleiben angemeldet, und Cloud benachrichtigt die Person.
- **Benachrichtigungen:** Erstelle Entwürfe für Benachrichtigungen, prüfe die Empfängervorschau und schließe den Batch ab. Prüfe danach die Zustellzähler oder die fehlgeschlagenen Empfänger.
- **Anfragen:** Erstelle Konten aus offenen Anfragen oder lehne Anfragen ab. Gibst du beim Ablehnen eine Begründung an, sendet Cloud sie per E-Mail. Bestehende Anfragen bleiben verfügbar, wenn neue Anfragen in der Cloud-Administration ausgeschaltet sind.
:::

:::info Änderungen im Audit-Protokoll nachverfolgen
Das **Audit-Protokoll** erfasst Konto- und Zugriffsänderungen. Filtere nach Dienstkonto, um die Aktivität von API-Schlüsseln zu untersuchen.
:::

## POSIX-Gruppe erstellen {icon="users"}

Wähle beim Anlegen einer lokalen Gruppe **Als POSIX-Gruppe erstellen**, um eine feste GID zu vergeben. Die Option ist anfangs aus und setzt in der Cloud-Administration eingeschaltete lokale Linux-Identitäten voraus. Ohne sie bleibt die Gruppe eine logische Gruppe. Schlägt die Vergabe fehl, legt Konten keine Gruppe an.

:::warning Du kannst die Vergabe einer GID nicht rückgängig machen
Nur die Administration kann eine GID vergeben.
:::

Um eine bestehende Gruppe umzuwandeln, wähle in ihren Aktionen **In POSIX-Gruppe umwandeln**.

FreeIPA verwaltet seine Gruppen unabhängig davon. Keine der beiden Aktionen legt Dateien an.

## Persönliche Linux-Gruppen finden {icon="user"}

Erhält ein lokales Konto eine Linux-Identität, legt Cloud dafür auch eine persönliche Linux-Gruppe an. Sie trägt den Benutzernamen des Kontos und ist dessen primäre Gruppe. Linux braucht sie, sie ist aber kein Team.

Die Gruppenliste blendet persönliche Linux-Gruppen aus. So zeigst du sie an:

:::steps
1. Öffne **Ansicht**.
2. Wähle **Linux → Persönliche Gruppen**.
:::

Die Anzahl über der Liste zählt nur die angezeigten Gruppen. Jede persönliche Gruppe zeigt **Persönlich · von** und den Namen der Person. Der Name verweist auf ihr Konto.

Eine persönliche Linux-Gruppe kannst du nicht löschen, solange sie die primäre Gruppe ihrer Person ist. Gruppenauswahlen, etwa beim Teilen, beim Zugriff und bei **Zu Gruppe hinzufügen**, bieten persönliche Gruppen nicht an. Wähle stattdessen die Person.
