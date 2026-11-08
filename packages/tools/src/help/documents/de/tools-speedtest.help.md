---
id: tools-speedtest
title: Verbindung messen
icon: ti ti-gauge
description: Miss Download, Upload, Ping, Jitter und Latenz unter Last zum angegebenen Server.
order: 115
---

## Test starten {icon="player-play"}

Öffne **Speedtest**, prüfe den **Messserver** und wähle
**Schnell · 14 s** oder **Genau · 29 s**; länger dauert ein Test nicht.
Drücke **Test starten**.
Ping, Download und Upload laufen nacheinander. Die Restzeit sinkt; ein stabiles
Ergebnis kann den Test früher beenden. **Stoppen** bricht die Übertragungen ab.

Der Server empfängt anonyme Testdaten und sieht deine IP-Adresse. Der Test
überträgt keine Cloud-Zugangsdaten und keine persönlichen Dateien. Andere
Übertragungen, WLAN und der Weg zum Messserver beeinflussen das Ergebnis.
Es gilt nicht für jedes Ziel im Internet.

Du kannst denselben Test auch direkt auf der öffentlichen Seite des Messservers
nutzen, ohne Anmeldung. Für Browser, CLI und Skripte gilt gemeinsam: höchstens
zwei gestartete Tests je Internetzugang innerhalb von 60 Sekunden. Ein Abbruch
zählt mit. Im Büro teilen sich alle hinter demselben Internetanschluss das
Limit; bei IPv6 gilt es pro /64-Netz. Nach zwei Starts zeigt der Countdown,
wann du erneut messen kannst.

## Ergebnis lesen und behalten {icon="chart-line"}

Die große Anzeige zeigt den Download, die Kacheln zeigen Upload, Ping, Jitter
und Latenz unter Last. Das Terminal zeigt dieselben Messwerte. Der Verlauf
zeichnet den Anlauf als dünne graue Linie; er zählt nicht zur Übertragungsrate. Ping ist der Median; Jitter die mittlere Differenz aufeinanderfolgender
Pings. **Latenz unter Last** misst die Antwortzeit während der Übertragung.
Ein Strich bedeutet, dass keine abgeschlossene Messung vorliegt. Während der Messung bleibt die Zeitachse fest;
im Ergebnis endet sie bei der tatsächlichen Dauer. Lange Terminalzeilen
bleiben in einer Zeile und lassen sich seitlich scrollen.

Nach **Fertig** kopiert **Ergebnis kopieren** das JSON. **--json** zeigt es im
Terminal-Panel und startet keine zweite Messung. **Erneut testen** beginnt neu.

## Nach einem Fehler fortfahren {icon="refresh"}

- Offline: Verbinde dich und drücke **Test starten**.
- Server nicht erreichbar oder zu langsam: Prüfe die Verbindung und wähle **Erneut versuchen**.
- Zwei Tests gestartet: Warte den angezeigten Countdown ab und wähle **Erneut versuchen**.
- Server ausgelastet: Warte den angezeigten Countdown ab. Ein abgelehnter Start zählt nicht zum Testlimit.
- Bandbreitenbudget des Servers erreicht: Der Test hat kein gültiges Ergebnis. Versuche es später erneut.
- Deaktiviert oder ungültige Serveradresse: Wende dich an den Cloud-Betreiber.

## Im Terminal messen {icon="terminal"}

Wähle **Cloud CLI**, **Node** oder **Bun** und kopiere den Befehl. Die Skripte
kommen jetzt vom eigenständigen Messserver statt von Cloud. Python-Skripte
entfallen. Lade das Skript vor dem Ausführen herunter.

`cld tools speedtest` nutzt die Servereinstellungen des Cloud-Profils, wenn dort
eine Cloud-URL hinterlegt ist. Ohne Cloud-URL gilt `https://speedtest.k2b.dev`.
`cld tools speedtest --server https://speedtest.example.com --mode accurate --json`
wählt ausdrücklich ein unabhängiges Ziel. Fortschritt geht nach stderr; stdout
enthält nur das fertige strukturierte Ergebnis. Strg+C bricht ab.

Nur ein ausdrückliches `--udp` startet die getrennte Diagnose für UDP-Jitter
und Paketverlust. Sie misst keine Übertragungsrate. Browser und Standard-CLI
nutzen kein UDP.
