---
id: proxy-auth-setup
title: Traefik konfigurieren
icon: ti ti-route
description: Eine Client-Prüf-URL mit ForwardAuth verbinden und die gelieferten Identitäts-Header weiterleiten.
order: 110
---

Proxy Auth entscheidet, ob eine angemeldete Cloud-Person einen geschützten Dienst erreichen darf. Traefik bleibt dafür zuständig, die Prüf-URL vor der Weiterleitung der ursprünglichen Anfrage aufzurufen.

## Einrichtung {icon="square-plus"}

:::steps
1. Erstelle einen Proxy-Auth-Client für einen geschützten Dienst oder eine Route.
2. Füge mindestens eine erlaubte Gruppe hinzu.
3. Kopiere die erzeugte Prüf-URL.
4. Konfiguriere diese URL als Adresse einer Traefik-ForwardAuth-Middleware.
5. Konfiguriere die Middleware so, dass sie die auf der Proxy-Auth-Seite genannten Identitäts-Header weiterleitet.
6. Verknüpfe die Middleware mit dem geschützten Router.
7. Teste abgemeldet, mit einer erlaubten Person und mit einer angemeldeten Person außerhalb der erlaubten Gruppen.
:::

## Gruppen bewusst wählen {icon="book-2"}

- Nutze eine zweckgebundene Gruppe, wenn der Dienst keinen breiten Plattformzugriff erben soll.
- Verschachtelte Gruppenmitgliedschaften zählen zum wirksamen Zugriff.
- Ein Client ohne erlaubte Gruppen verweigert absichtlich jeder angemeldeten Person den Zugriff.
- Verwende getrennte Clients für Dienste mit unterschiedlichen Gruppenzugriffen, auch wenn sie denselben Upstream-Host nutzen.

:::warning Die Prüf-URL ist Konfiguration, kein Benutzerlink
Personen öffnen den geschützten Dienst. Traefik ruft die Prüf-URL im Hintergrund für jede geschützte Anfrage auf.
:::
