---
id: spaces-troubleshooting
title: Probleme in Spaces beheben
icon: ti ti-lifebuoy
description: Finde fehlende Spaces oder Einträge, behebe unerwartete Ansichten und Probleme mit Zuständigkeiten und repariere Kalenderexporte und Einladungen aus Mail.
order: 140
---

## Häufige Probleme beheben {icon="lifebuoy"}

:::reference
- **Ein Space fehlt in der Übersicht:** Prüfe, ob du noch Zugriff auf den Space hast. Ein Space, der über eine Gruppe geteilt ist, kann verschwinden, wenn sich deine Gruppenmitgliedschaft ändert.
- **Ein Eintrag fehlt:** Entferne die Suche und alle Filter-Chips. Prüfe dann die aktuelle Ansicht. Eine Ansicht, die nur Kalendereinträge zeigt, kann eine Aufgabe ohne Datum ausblenden.
- **Kanban zeigt die falsche Spalte:** Kanban gruppiert nach dem gewählten Gruppierungsfeld, meist dem Status. Öffne den Eintrag und korrigiere dieses Feld. Ändere keine anderen Filter.
- **Eine zuständige Person kann die Arbeit nicht bearbeiten:** Zugriff **Ansehen** genügt nicht, um Einträge zu ändern. Die Person oder eine ihrer Gruppen braucht Zugriff **Bearbeiten** oder **Verwalten**.
- **Ein abgeschlossener Eintrag wird weiter angezeigt:** Prüfe die aktiven Filter und die Gruppierung. Manche Ansichten zeigen abgeschlossene Arbeit absichtlich an.
- **Eine Aufgabe kann nicht abgeschlossen werden:** Sieh unter **Blockiert durch** im Block **Planung** der Aufgabe nach. Offene blockierende Aufgaben zeigen ein Schloss. Schließe zuerst alle offenen blockierenden Aufgaben ab oder entferne die Abhängigkeiten. Abgeschlossene blockierende Aufgaben bleiben als Kontext sichtbar, bis du sie entfernst.
- **Ein abonnierter Kalender ist veraltet:** Kalenderprogramme aktualisieren Abonnements nach ihrem eigenen Zeitplan. Prüfe, ob das Programm die aktuelle Export-URL verwendet. Erzeuge die URL bei Bedarf in Spaces neu und ersetze das alte Abonnement.
- **Eine Einladung aus Mail kann nicht importiert werden:** Prüfe, ob Spaces läuft. Prüfe, ob der Anhang genau einen unterstützten Termin vom Typ REQUEST, PUBLISH oder CANCEL enthält. Prüfe, ob du Zugriff **Bearbeiten** auf den gewählten Space hast. Ein Standard-Space ist nur ein Vorschlag.
- **Die Antwortaktion fehlt in Mail:** Prüfe, ob die Nachricht eine unterstützte REQUEST-Einladung enthält. Prüfe, ob du mindestens einen Space bearbeiten kannst und Mail eine bestätigte Absenderidentität hat. Die Antwortaktion speichert oder aktualisiert den Termin und bereitet einen bearbeitbaren Entwurf in Mail vor. Sie umgeht nicht die Prüfung vor dem Versand.
- **Der Einladungsentwurf ist fehlgeschlagen:** Öffne den Termin in Spaces und lies die Meldung unter **Einladungen**. Korrigiere den Zugriff auf Mail oder die bestätigte Absenderidentität. Starte den Vorgang dann ausdrücklich erneut. Der Idempotency-Key verhindert, dass ein erneuter Versuch einen zweiten Entwurf erzeugt.
:::

## Unübersichtliche Ansicht zurücksetzen {icon="layout-list"}

:::steps
1. Kehre über die Spaces-Übersicht zum Space zurück.
2. Wähle in der Seitenleiste des Space **Übersicht**. Sie zeigt die Einträge ohne Aufteilung in Kanban-Spalten oder Kalenderzeiträume.
3. Entferne die Suche und alle Filter-Chips.
4. Öffne den fehlenden Eintrag über eine andere bekannte Ansicht oder die globale Suche.
5. Aktiviere die Filter erneut, einen nach dem anderen.
:::

## Kalenderlink ersetzen {icon="calendar-share"}

:::warning Kalenderlinks gewähren Zugriff
Jede Person mit einer funktionierenden Export-URL kann die exportierten Termindetails lesen.
:::

Wurde ein Link zu weit verbreitet, erzeuge die Export-URL neu und ersetze das Abonnement.
