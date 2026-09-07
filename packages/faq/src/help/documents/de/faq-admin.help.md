---
id: faq-admin
title: FAQs pflegen
icon: ti ti-edit
description: Nützliche Fragen schreiben, Zielgruppen wählen, Markdown prüfen und veraltete Einträge entfernen.
order: 110
---

Jeder FAQ-Eintrag sollte eine Frage beantworten, die Leserinnen und Leser wiedererkennen. Produktabläufe gehören in die Hilfe der besitzenden App; FAQ ist für kurze übergreifende Antworten gedacht.

## Einen Eintrag schreiben {icon="pencil"}

:::steps
1. Schreibe die englische Frage und Antwort vollständig.
2. Fülle beide deutschen Felder aus, wenn der Eintrag auf Deutsch verfügbar sein soll; lasse sonst beide leer.
3. Gib die direkte Antwort im ersten Satz.
4. Ergänze nur die Schritte, Bedingungen oder Links, die zum Handeln nötig sind.
5. Wähle alle Zielgruppen, für die die Antwort sichtbar sein soll.
6. Speichere und prüfe beide Sprachvarianten in der öffentlichen FAQ.
:::

Englisch ist die verpflichtende Rückfallsprache jedes Eintrags. Die öffentliche
FAQ verwendet zuerst die genaue Locale, dann deren Sprache und schließlich
Englisch. Zielgruppe und Listenposition gelten für den gesamten Eintrag.

## Eine Zielgruppe wählen {icon="shield-lock"}

- **Anonym** gilt für nicht angemeldete Personen.
- **Gastprofil** gilt für lokale und IPA-Konten mit Gastprofil.
- **Vollprofil** gilt für lokale und IPA-Konten mit Vollprofil.
- Wähle mehrere Zielgruppen, wenn die Antwort für mehr als eine Gruppe gilt.

:::warning Zielgruppe steuert Sichtbarkeit, nicht Schwärzung
Speichere keine Geheimnisse oder privaten Betriebsdaten in einer FAQ-Antwort. Der Zielgruppenfilter steuert, welche Einträge gelistet werden; er ersetzt keine sicheren Inhalte.
:::

## Die Liste pflegen {icon="point"}

- Aktualisiere Bezeichnungen und Anleitungen, wenn sich die zugehörige Oberfläche ändert.
- Entferne Duplikate, indem du die klarste Frage behältst und bei Bedarf auf ein längeres Hilfethema verweist.
- Lösche einen Eintrag nur, wenn die Antwort für keine ausgewählte Zielgruppe mehr gültig oder nützlich ist.

## Mit der CLI automatisieren {icon="terminal"}

Administratoren können dieselben Einträge mit `cld faq` auflisten, erstellen,
aktualisieren, sortieren und löschen. `cld faq help` zeigt alle Befehle.
Übergib lokalisiertes Markdown als Übersetzungs-JSON-Datei oder über die
Standardeingabe. Jedes Übersetzungsobjekt muss Englisch enthalten und darf
weitere gültige Locales enthalten.
