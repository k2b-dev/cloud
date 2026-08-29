---
id: proxy-auth-start
title: Erste Schritte
icon: ti ti-load-balancer
description: ForwardAuth-Clients, Gruppenzugriffe, Prüf-URLs und Antwort-Header.
order: 100
---

Mit Proxy Auth schützen Personen mit Administratorrechten externe Dienste über Traefik ForwardAuth. Jeder Client erhält einen eigenen Prüfendpunkt; der Zugriff wird für ausgewählte Kontogruppen freigegeben.

## Überblick {icon="layout-grid"}

:::reference
- **Client:** Ein geschützter externer Dienst oder eine Route. Jeder Client hat eine stabile Prüf-URL mit eigener Client-ID.
- **Erlaubte Gruppen:** Eine Person muss mindestens einer erlaubten Gruppe angehören, bevor der Prüfendpunkt Zugriff gewährt.
- **Prüf-URL:** Traefik ruft `/proxy-auth/verify/<client-id>` auf, bevor die ursprüngliche Anfrage an den Upstream-Dienst weitergeleitet wird.
- **Weitergeleitete Header:** Bei Erfolg liefert der Endpunkt Header für Person, E-Mail-Adresse und wirksame direkte oder verschachtelte Gruppen an den Upstream-Dienst.
:::

## Administrationsablauf {icon="route"}

:::reference
- **Client erstellen:** Benenne den Client, ergänze bei Bedarf eine Beschreibung und wähle mindestens eine erlaubte Gruppe.
- **Prüf-URL kopieren:** Kopiere die URL nach der Erstellung oder über das Aktionsmenü des Clients und hinterlege sie in der Traefik-ForwardAuth-Middleware.
- **Gruppenabdeckung prüfen:** Die Kennzahl Keine Gruppen hebt Clients hervor, die ohne konfigurierte Gruppe gesperrt bleiben.
- **Zugriff ändern:** Ändere Beschreibung oder erlaubte Gruppen über die Client-Bearbeitung. Löschen entfernt den Client und macht seine Prüf-URL ungültig.
:::

:::info Zugriffsergebnis
Der Prüfendpunkt leitet nicht angemeldete Personen zur Anmeldung weiter, antwortet bei angemeldeten Personen außerhalb der erlaubten Gruppen mit 403 und bei erlaubtem Zugriff mit 200 sowie den weitergeleiteten Identitäts-Headern.
:::
