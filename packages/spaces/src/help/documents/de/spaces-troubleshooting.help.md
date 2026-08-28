---
id: spaces-troubleshooting
title: Probleme beheben
icon: ti ti-lifebuoy
description: Fehlende Spaces oder Einträge, unerwartete Ansichten, Zuständigkeiten und Kalenderexporte prüfen.
order: 140
---

## Häufige Probleme {icon="lifebuoy"}

:::reference
- **Ein Space fehlt in der Übersicht:** Prüfe, ob du noch Lesezugriff hast. Ein über eine Gruppe freigegebener Space kann verschwinden, wenn sich deine Gruppenmitgliedschaft ändert.
- **Ein Eintrag fehlt:** Entferne die Suche und alle Filter-Chips. Prüfe anschließend die aktuelle Ansicht. Eine Aufgabe ohne Datum erscheint möglicherweise nicht in einer Ansicht, die nur Kalendereinträge zeigt.
- **Kanban zeigt die falsche Spalte:** Die Kanban-Gruppierung richtet sich nach dem gewählten Gruppierungsfeld, meist dem Status. Öffne den Eintrag und korrigiere dieses Feld, anstatt andere Filter zu verschieben.
- **Eine zuständige Person kann die Arbeit nicht bearbeiten:** Lesezugriff genügt nicht, um Einträge zu ändern. Die Person oder eine ihrer Gruppen benötigt Schreib- oder Adminzugriff.
- **Ein abgeschlossener Eintrag wird weiterhin angezeigt:** Prüfe die aktiven Filter und die Gruppierung. Manche Ansichten zeigen abgeschlossene Arbeit absichtlich an.
- **Eine Aufgabe kann nicht abgeschlossen werden:** Öffne **Blockiert durch**. Schließe zuerst alle aktiven blockierenden Aufgaben ab oder entferne die Abhängigkeiten. Abgeschlossene blockierende Aufgaben bleiben als Kontext sichtbar, bis du sie entknüpfst.
- **Ein abonnierter Kalender ist veraltet:** Kalenderprogramme aktualisieren Abonnements nach ihrem eigenen Zeitplan. Prüfe, ob das Programm die aktuelle Export-URL verwendet. Erzeuge die URL bei Bedarf in Spaces neu und ersetze das alte Abonnement.
- **Eine Einladung aus Mail kann nicht importiert werden:** Prüfe, ob Spaces ausgeführt wird, der Anhang genau einen unterstützten Termin vom Typ REQUEST, PUBLISH oder CANCEL enthält und du Schreibzugriff auf den gewählten Space hast. Ein Standard-Space ist nur ein Vorschlag.
- **Die Antwortaktion fehlt in Mail:** Prüfe, ob die Nachricht eine unterstützte REQUEST-Einladung enthält, du in mindestens einen Space schreiben darfst und Mail über eine bestätigte Absenderidentität verfügt. Die Antwortaktion speichert oder aktualisiert den Termin und bereitet einen bearbeitbaren Entwurf in Mail vor. Sie umgeht nicht die Prüfung vor dem Versand.
- **Der Einladungsentwurf ist fehlgeschlagen:** Öffne den Termin in Spaces und prüfe die Meldung unter **Einladungen**. Korrigiere den Zugriff auf Mail oder die bestätigte Absenderidentität und starte den Vorgang erneut. Der Idempotency-Key verhindert, dass bei einem erneuten Versuch ein zweiter Entwurf entsteht.
:::

## Eine unübersichtliche Ansicht zurücksetzen {icon="layout-list"}

:::steps
1. Kehre über die Spaces-Übersicht zum Space zurück.
2. Wähle die Liste. Sie zeigt die Einträge ohne Aufteilung in Kanban-Spalten oder Kalenderzeiträume.
3. Entferne die Suche und alle Filter-Chips.
4. Öffne den fehlenden Eintrag über eine andere bekannte Ansicht oder die globale Suche.
5. Aktiviere die benötigten Filter nacheinander erneut.
:::

:::warning Kalenderlinks gewähren Zugriff
Jede Person mit einer funktionierenden Export-URL kann möglicherweise die exportierten Termindetails lesen. Erzeuge die Export-URL neu und ersetze das Abonnement, wenn der Link zu weit verbreitet wurde.
:::
