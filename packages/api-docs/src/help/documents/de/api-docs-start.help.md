---
id: api-docs-start
title: Erste Schritte
icon: ti ti-books
description: Eine API auswählen, Vorgänge und Schemas lesen, Authentifizierung verstehen und die CLI-Referenz nutzen.
order: 100
---

API Docs bündelt die OpenAPI-Referenzen laufender Cloud-Apps. Beginne hier und wähle anschließend eine App in der Quellenauswahl.

## Die benötigte API finden {icon="search"}

- Wähle die App, der die gewünschten Daten oder Aktionen gehören.
- Suche in der Referenz nach Vorgangsname, Route, Feld oder Schema.
- Öffne einen Vorgang, um HTTP-Methode, Pfad, Parameter, Request-Body, Antworten und deklarierte Authentifizierung zu sehen.
- Nutze Schemas, um wiederverwendbare Objekte mehrerer Vorgänge zu verstehen.

## Einen Vorgang lesen {icon="route"}

:::steps
1. Prüfe die ausgewählte App.
2. Lies Zusammenfassung und Beschreibung, bevor du den Pfad kopierst.
3. Prüfe alle erforderlichen Pfad-, Query- und Header-Parameter.
4. Gleiche den Request-Body mit dem dokumentierten Schema ab.
5. Prüfe Erfolgs- und Fehlerantworten, bevor du den Vorgang integrierst.
:::

:::warning Dokumentation erteilt keinen Zugriff
Ein Vorgang kann in API Docs erscheinen, obwohl dein Konto oder deine Integration ihn nicht aufrufen darf. Nutze die dokumentierte Authentifizierung und fordere nur den benötigten Zugriff an.
:::

## Die CLI nutzen {icon="code"}

- `cld api-docs list` listet Apps auf, die aktuell eine Referenz veröffentlichen.
- `cld api-docs operations <app>` listet die Vorgänge einer App auf.
- `cld api-docs search "<query>"` durchsucht Vorgangsmetadaten und Schemas.
- `cld api-docs show <app> <method> <path>` zeigt einen Vorgang im Detail.
- `cld api-docs spec <app>` gibt das unveränderte OpenAPI-Dokument aus.

Wenn eine erwartete App fehlt, veröffentlicht sie derzeit keine sichere OpenAPI-Quelle in der aktiven App-Registry.
