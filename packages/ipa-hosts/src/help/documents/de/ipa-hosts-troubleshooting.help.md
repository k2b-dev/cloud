---
id: ipa-hosts-troubleshooting
title: Fehlerbehebung
icon: ti ti-lifebuoy
description: Veraltete Spiegel, fehlende Hosts, ungültige Metadaten, Mitgliedschaftsprobleme und Synchronisierungsfehler beheben.
order: 110
---

Hosts zeigt einen lokalen Spiegel, während FreeIPA die maßgebliche Quelle bleibt. Wenn Oberfläche und Verzeichnis voneinander abweichen, prüfe, ob der Schreibvorgang fehlgeschlagen ist oder nur eine erfolgreiche Synchronisierung fehlt.

## Häufige Symptome {icon="lifebuoy"}

:::reference
- **Ein Host oder eine Hostgruppe fehlt:** Leere die Suche, prüfe die Seitennavigation und starte Jetzt synchronisieren, wenn sich das Verzeichnis kürzlich geändert hat.
- **Ein kürzlich geänderter Wert wurde zurückgesetzt:** Ein weiterer FreeIPA-Schreibvorgang oder eine spätere Synchronisierung kann ihn ersetzt haben. Prüfe die protokollierte Aktion und den aktuellen Verzeichniswert.
- **Ein Host bleibt nicht gruppiert:** Öffne das Aktionsmenü des Hosts, füge mindestens eine Hostgruppe hinzu und prüfe, ob die nächste Synchronisierung abgeschlossen wird.
- **Eine MAC-Adresse wird abgelehnt:** Verwende das erwartete hexadezimale Adressformat und entferne Duplikate.
- **Eine Hostgruppe lässt sich nicht löschen:** Entferne oder verschiebe abhängige Mitgliedschaften und versuche es nur erneut, wenn das Verzeichnis die Löschung zulässt.
- **Die geplante Synchronisierung läuft nicht:** Prüfe den fünfteiligen Cron-Ausdruck, die konfigurierte Zeitzone, die Zugangsdaten des Dienstkontos und den letzten Synchronisierungsfehler.
:::

## Sicherer Wiederherstellungsweg {icon="lifebuoy"}

:::steps
1. Notiere den genauen Host- oder Hostgruppennamen und den Zeitpunkt der fehlgeschlagenen Aktion.
2. Aktualisiere die Seite einmal, um einen veralteten Stand auszuschließen.
3. Starte eine manuelle Synchronisierung, wenn die FreeIPA-Quelle nachweislich korrekt ist.
4. Wiederhole einen einzelnen, eng begrenzten Schreibvorgang.
5. Nutze Audit-Verlauf oder CLI-Ausgabe, wenn dieselbe Aktion erneut fehlschlägt.
:::

:::warning Maßgebliche Quelle
Erstelle fehlende gespiegelte Einträge nicht wiederholt neu. Behebe den FreeIPA-Eintrag oder das Verbindungsproblem und synchronisiere anschließend den Spiegel.
:::
