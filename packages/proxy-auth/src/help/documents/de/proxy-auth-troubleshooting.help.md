---
id: proxy-auth-troubleshooting
title: Fehlerbehebung
icon: ti ti-lifebuoy
description: Anmeldeschleifen, verweigerte Zugriffe, fehlende Identitäts-Header und ungültige Prüf-URLs untersuchen.
order: 120
---

## Zuerst das Ergebnis lesen {icon="square-plus"}

:::reference
- **Weiterleitung zur Anmeldung:** Die Anfrage enthält keine gültige Cloud-Sitzung. Prüfe, ob der Browser die normale Cloud-Anmeldung erreicht und Cookies für den erwarteten Ursprung sendet.
- **403 Forbidden:** Die Person ist angemeldet, gehört aber keiner erlaubten Gruppe an. Prüfe wirksame und verschachtelte Gruppenmitgliedschaften.
- **404 oder ungültiger Client:** Die Prüf-URL ist falsch oder der Client wurde gelöscht. Kopiere die aktuelle URL aus dem Aktionsmenü des Clients.
- **Der Upstream erhält keine Identität:** Prüfe, ob die ForwardAuth-Middleware die auf der Proxy-Auth-Seite aufgeführten Antwort-Header weiterleitet.
:::

## Diagnoseweg {icon="lifebuoy"}

:::steps
1. Teste die geschützte Route in einer normalen Browsersitzung.
2. Prüfe, ob der Proxy-Auth-Client noch vorhanden ist und erlaubte Gruppen besitzt.
3. Vergleiche die konfigurierte Prüf-URL mit der aktuell kopierten URL.
4. Prüfe die wirksame Gruppenmitgliedschaft der Person in Accounts.
5. Prüfe die Traefik-Protokolle auf das Middleware-Ergebnis und die Weiterleitung der Upstream-Header.
:::

:::note Authentifizierung und Autorisierung sind getrennt
Eine erfolgreiche Cloud-Anmeldung bestätigt die Identität. Proxy Auth antwortet weiterhin mit 403, wenn diese Identität außerhalb der erlaubten Gruppen liegt.
:::
