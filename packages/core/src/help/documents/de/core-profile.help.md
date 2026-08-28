---
id: core-profile
title: Profil und Konto
icon: ti ti-user-circle
description: Kontodaten, FreeIPA-Anträge, API-Schlüssel, Passkeys, Gruppen und Kontoaktivitäten.
order: 110
---

Der Kontobereich bündelt lokale Cloud-Daten, optionale FreeIPA-Daten und die Selbstverwaltung für die angemeldete Person.

## Kontobereiche {icon="paperclip"}

:::reference
- **Identität:** Zeigt Anzeigename, Benutzername, Profilbild, Kontodienst, Profiltyp, zusätzliche Rollen, E-Mail-Adresse, Telefonnummer, Adresse sowie verfügbare Ablaufdaten.
- **Gruppen:** Zeigt zunächst direkte Gruppenmitgliedschaften. **Geerbte anzeigen** ergänzt Mitgliedschaften aus der Gruppenhierarchie.
- **FreeIPA-Antrag:** Lokale Konten können bei aktiviertem FreeIPA ein zentral verwaltetes Konto beantragen. Ein ausstehender Antrag kann im selben Bereich zurückgezogen werden.
- **Aktivitäten:** Zeigt sicherheitsrelevante Kontoaktivitäten der letzten 7, 30 oder 90 Tage.
:::

## Sicherheitsfunktionen {icon="shield-lock"}

:::reference
- **API-Schlüssel:** Persönliche Automatisierungszugänge, die die Berechtigungen des Kontos übernehmen. Der vollständige Schlüssel wird nur direkt nach der Erstellung angezeigt.
- **Passkeys:** WebAuthn-Passkeys für die Anmeldung am eigenen Konto. Nach dem Entfernen ist die Anmeldung mit diesem Passkey nicht mehr möglich.
:::
