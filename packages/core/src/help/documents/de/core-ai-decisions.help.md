---
id: core-ai-decisions
title: Ein Entscheidungsmodell fragen
kind: task
icon: ti ti-sparkles
description: Informationen in Gustav, Code oder der CLI mit Wahrscheinlichkeiten einordnen.
order: 600
---

Bitte Gustav, Informationen mit einem Entscheidungsmodell einzuordnen, wenn du
eine Kategorie, Ja/Nein-Einschätzung oder Bewertung mit Wahrscheinlichkeiten
brauchst. Ein Cloud-Admin muss zuerst ein Entscheidungsmodell in den
KI-Einstellungen zuweisen. Du brauchst das Nutzungsrecht am Modell und genügend
KI-Kontingent. Code nutzt das Kontingent seiner Person oder seines Dienstkontos.
Dienstkonten von Ressourcen- und App-Code brauchen ein eigenes Modellnutzungsrecht
und bei aktiven Kontingenten ein eigenes Kontingent; persönliche Vorgaben gelten
für sie nicht. Die Code-Richtlinie des Cloud-Admins entscheidet, ob eine Version mit KI eine
Freigabe braucht.

## Eine Nachricht einordnen {icon="mail"}

Frage zuerst nach der Kategorie. Frage Dringlichkeit zusammen mit der Kategorie
oder danach ab, nie allein: Spam verwendet oft dringliche Formulierungen. Nutze
Dringlichkeit nur innerhalb einer passenden Kategorie, etwa Support.
Wahrscheinlichkeiten sind Schätzungen; prüfe unsichere Nachrichten selbst, bevor
du handelst.

Die Entscheidung liest die übergebenen Informationen und ändert keine Mails oder
anderen Datensätze. Eine spätere Änderung ist eine eigene Aktion. Bilder
funktionieren nur, wenn Anbieter und Modell sie unterstützen, und müssen in die
Größengrenze des Aufrufs passen.

## Wenn die Entscheidung fehlschlägt {icon="alert-circle"}

Ist kein Modell eingerichtet, bitte einen Cloud-Admin um die Zuweisung. Darfst du
das ausgewählte Modell nicht nutzen, wähle ein für dein Konto geteiltes Modell.
Prüfe bei erschöpftem Kontingent deinen KI-Verbrauch vor einem weiteren Versuch.
Verkleinere große Eingaben oder entferne nicht unterstützte Bilder. Eine
fehlgeschlagene oder abgebrochene Entscheidung liefert keine nutzbare Antwort.
