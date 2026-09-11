# Assistant: Plus-Menü und Kontext-Popup aufräumen

Status: Umsetzung freigegeben und implementiert; Abschlussprüfung siehe unten.

## Ziel und Verhalten

- „Ressource einfügen“ aus dem Plus-Menü entfernen. „Dateien anhängen“,
  „Ressource wählen“ und im bestehenden Chat „Chat durchsuchen“ bleiben.
  Normales Einfügen mit Strg/Cmd+V im Composer bleibt erhalten.
- „Kontext kürzen“ aus dem Plus-Menü in den unteren Bereich des
  Kontext-Popups verschieben, als kleine, beschriftete Aktion.
- Hover öffnet weiterhin die Kontextinformationen. Ein Klick auf den bereits
  durch Hover geöffneten Auslöser hält das Popup offen, statt es zu schließen.
  Ein weiterer bewusster Klick auf den angehefteten Auslöser darf schließen.
- Ohne Klick schließt das Popup nach Verlassen von Auslöser und Popup;
  der Zeiger kann sicher zur Aktion wandern. Nach Klick bleibt es offen,
  bis Außenklick, Escape oder erneuter Auslöserklick es schließt.
- Touch öffnet per Tap. Enter/Leertaste öffnen; Tab erreicht die Aktion.
  Hover stiehlt keinen Fokus. Beim Schließen aus dem Popup per Escape geht
  der Fokus zum Auslöser zurück. Sichtbare Fokusmarkierung und korrekte
  Expanded-/Controls-Semantik; interaktive Inhalte sind kein Tooltip.

## Befund und Verantwortung

`AssistantWorkspace.island.tsx` liefert beide bisherigen Menüaktionen.
`pasteComposerResource` ist der separate Menü-Handler; `pasteComposerContent`
implementiert normales Einfügen und bleibt erhalten. Vor Entfernen ungenutzter
Handler oder Texte deren weitere Aufrufer prüfen.

`ChatContextUsage` in `packages/ui/src/chat/ChatPrimitives.tsx` verwendet
`Tooltip.Trigger`. Dessen Surface schließt ausdrücklich bei `pointerdown`
und beim Verlassen des Auslösers. Einfach einen Button in diesen Tooltip
zu setzen löst weder Erreichbarkeit noch Semantik.

Die interaktive Kontextanzeige gehört in das eigenständig nutzbare `@k2b/ui`.
Dort gezielt `Chat.ContextUsage` um eine optionale Aktion und das passende
Popup-Verhalten erweitern; bestehende Positionierungs-/Surface-Mechanismen
prüfen und wiederverwenden. Keinen app-eigenen generischen Popover bauen und
nicht pauschal das Verhalten aller Tooltips ändern. Ein neuer universeller
Popover-Vertrag ist nur bei tatsächlich fehlender Grundlage zu begründen.

Assistant liefert Beschriftung, Verfügbarkeit und Callback für die Kürzung.
`Chat.Composer` reicht die Popup-Aktion durch. Das bestehende `contextActions`
zeichnet Buttons neben der Anzeige und soll nicht stillschweigend eine neue
Bedeutung bekommen. Alle realen ContextUsage-/Composer-Aufrufer prüfen;
Aufrufer ohne Aktion behalten die reine Informationsanzeige.

## Umsetzungsschritte

1. Menü bereinigen; normalen Paste-Pfad bewahren und ausschließlich danach
   ungenutzten Menü-Code entfernen.
2. Kontext-Popup mit Hover-Vorschau und Klick-Anheftung implementieren;
   kompakte Aktion über den öffentlichen UI-Vertrag einbinden.
3. Bestehenden `compactConversation`-Aufruf inklusive Modellwahl verwenden.
   Aktion nur bei geeignetem bestehenden Chat anbieten; während laufendem
   Turn oder laufender Kürzung deaktivieren und Doppelaufrufe verhindern.
   Fehler über den vorhandenen Feedback-Pfad sichtbar halten. Fehlende
   Tokenwerte dürfen nicht unbeabsichtigt die bisher erreichbare Kürzung
   verschwinden lassen; leere Chats und Projekt-Composer explizit prüfen.
4. Kanonische UI-Dokumentation und betroffene Assistant-Hilfe DE/EN anpassen.

## Abnahme

- Plus-Menü enthält die gewünschten drei Einträge im bestehenden Chat.
- Hover, Hover-dann-Klick, Wechsel vom Auslöser zur Aktion, Außenklick,
  Escape, Touch und Tastatur in einem echten Browser prüfen.
- Kompaktierung wird genau einmal ausgelöst; Busy-/Fehlerzustand, Modellwahl
  und bestehende Berechtigungen bleiben erhalten.
- Normales Einfügen von Ressourcen/Text funktioniert weiterhin.
- Fokussierte Verhaltens-/Render-Tests für Popup-Zustände und Aktion,
  betroffene Typechecks sowie schmale/mobile und dunkle Darstellung prüfen.
- Fremde parallele Änderungen bewahren; kein Commit, Push oder Deployment
  allein aufgrund dieses Plans.


## Umsetzung und Prüfung

Das Plus-Menü enthält keine Paste- oder Kürzungsaktion mehr. Normaler Paste
bleibt unverändert. `contextPopupAction` reicht eine optionale Aktion in den
Kontextdialog durch und hält diesen bei fehlenden Tokenwerten erreichbar.
Der Kontextdialog verwendet die vorhandene Positionierungsfunktion, native
Popover-Darstellung und UI-Tokens; allgemeine Tooltips bleiben unverändert.

31 Render-Tests und ein DOM-Verhaltenstest bestanden. Chrome-Prüfung mit
Originalkomponenten: Hover plus Klick, Zeigerwechsel zur Aktion, Außenklick,
Enter/Tab/Escape, zweiter Klick, Touch-Pointer und 390-px-Darstellung in dunklem
Theme. Simulierter Fehler erreicht den Callback; Doppelaktivierung wird
während der Ausführung verhindert. UI-, DOM-Test- und Assistant-Typechecks
bestanden. Ein echter Kürzungslauf gegen einen Nutzerchat wurde nicht ausgelöst.

### Lokale Live-Abnahme blockiert

Assistant-Image erfolgreich gebaut. Der anschließende Start überschritt das
180-Sekunden-CLI-Zeitfenster; nach erfolgreicher Komponenten- und CSS-Kompilierung
bricht die gemeinsame Sync-Initialisierung ab:
`JetStreamApiError: JetStream system temporarily unavailable`.
Der Container startet automatisch erneut. Keine Infrastrukturänderung vorgenommen.
Die Aufgabe bleibt bis zur Bereitschaftsprüfung bei wieder verfügbarem JetStream
offen. Noch kein Commit für diese Menü-/Popup-Änderung.


### Stilkorrektur und Auslieferung geprüft

Die transparente Fläche war reproduzierbar: Core lieferte ein älteres globales
Stylesheet ohne Popup-Klasse, obwohl Assistant bereits die neue Komponente
enthielt. Core besitzt `/public/global.css` und muss bei neuen UI-Styles
mitgebaut werden.

Core neu gebaut und healthy. Vorher-/Nachher-Prüfung mit dem tatsächlich
ausgelieferten globalen CSS bestätigt die Popup-Fläche. Schrift 12 px,
Werte normal und Überschrift/CTA mit Gewicht 500; Inhalt 14 rem breit,
Abstände kompakter. Assistant ist ebenfalls healthy; der vorherige
JetStream-Blocker ist nicht mehr vorhanden. Kein echter Kürzungslauf ausgelöst.
