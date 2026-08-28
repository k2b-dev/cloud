---
id: mail-work
title: E-Mails lesen, suchen und organisieren
icon: ti ti-inbox
description: Unterhaltungen finden, vollständige Verläufe lesen und übertragbare E-Mail-Zustände sicher ändern.
order: 20
---

## Die passende Unterhaltung finden {icon="search"}

Mit **Postfach durchsuchen** suchst du schnell im aktuellen Postfach. Standardmäßig ist **Alles** ausgewählt. Die Suche umfasst synchronisierte Nachrichtenfelder und aus Anhängen erkannten Text. Über die Schaltfläche für den Suchbereich kannst du die Suche auf eine beliebige Kombination aus **Absender**, **Empfänger**, **Betreff**, **Nachrichtentext** und **Anhangsnamen** eingrenzen.

Wähle **Suchfilter**, wenn du weitere Bedingungen wie Datum, Empfänger, Anhänge, Ordner, Tags oder Zusammenarbeitsstatus benötigst.

Der Filterdialog zeigt die aktuelle Suche als bearbeitbare Bedingungen. Wähle **Filter hinzufügen**, um ein weiteres Feld zu ergänzen. Sind mehrere Filter aktiv, legst du fest, ob alle oder mindestens einer zutreffen müssen. **Erweiterte Bedingungen** bleibt geschlossen, bis du alternative oder verschachtelte Gruppen benötigst.

Der Filterdialog kann folgende Felder durchsuchen:

- Von
- An oder Cc
- Betreff
- Nachrichtentext
- Anhangsname
- Interner Kommentar
- Unterhaltungsreferenz
- Ordner
- Lokaler Tag

Wähle **Eine Bedingung**, damit mindestens ein ausgefülltes Feld übereinstimmen muss, oder **Alle Bedingungen**, damit jedes ausgefüllte Feld übereinstimmen muss. Suchfilter bleiben in der Seiten-URL erhalten. Ein Neuladen oder Teilen der URL bewahrt deshalb das aktuelle Ergebnis. Mit **Suche leeren** kehrst du zur ungefilterten Ansicht zurück.

Anbieter-Schlüsselwörter sind erweiterte synchronisierte Metadaten und kein normales Kennzeichnungssystem. Vorhandene Such-URLs mit Schlüsselwörtern funktionieren weiterhin und bleiben bearbeitbar. Neue Filter verwenden für sichtbare Kennzeichnungen lokale Tags.

Suchergebnisse werden anhand deiner Berechtigungen geprüft und verwenden die synchronisierte Cloud-Kopie. Während der ersten Synchronisierung können ältere Nachrichten oder Inhalte erst später durchsuchbar werden, wenn Synchronisierung und Laden der Nachrichtentexte fortschreiten.

Nachdem ein Anhang synchronisiert wurde, erkennt Mail im Hintergrund lesbaren Text aus unterstützten PDF-, Office-Dokument-, Tabellen-, Präsentations-, RTF-, EPUB- und CSV-Dateien. Die allgemeine Standardsuche umfasst diesen erkannten Anhangstext. Ein ausdrücklicher Filter für **Nachrichtentext** durchsucht nur den E-Mail-Inhalt, **Anhangsname** nur Dateinamen. Passwortgeschützte, gescannte, nicht unterstützte, fehlerhafte oder zu große Dateien bleiben herunterladbar, tragen aber keinen durchsuchbaren Text bei.

Wenn erkannter Anhangstext übereinstimmt, nennt das Ergebnis den Anhang, zeigt einen kurzen passenden Ausschnitt und öffnet genau die Nachricht, zu der er gehört. Verwende die Download-Aktion des Ergebnisses, wenn du die ursprüngliche Datei benötigst.

## Nachverfolgung, Zuordnung und Ordner gezielt verwenden {icon="layout-list"}

Die integrierten Ansichten unter **Nachverfolgung** zeigen, was als Nächstes geschehen soll. **Zuordnung** zeigt, wer zuständig ist:

| Abschnitt | Ansicht | Inhalt |
| --- | --- | --- |
| Nachverfolgung | Handlungsbedarf | Unterhaltungen, die das Team prüfen oder bearbeiten muss |
| Nachverfolgung | Wartet auf Antwort | Unterhaltungen, bei denen eine bestätigte Antwort des Teams auf eine Reaktion einer anderen Person wartet. Neue eingehende E-Mails verschieben sie zu Handlungsbedarf. |
| Nachverfolgung | Zurückgestellt | Unterhaltungen, die bis zu ihrem Wiedervorlagezeitpunkt ausgeblendet sind. Der Zeitpunkt blendet sie wieder ein, ohne ihren nächsten Schritt zu ändern. Neue eingehende E-Mails blenden sie sofort wieder ein. |
| Nachverfolgung | Erledigt | Als erledigt markierte Unterhaltungen |
| Zuordnung | Mir zugewiesen | Dir zugewiesene Unterhaltungen |
| Zuordnung | Nicht zugewiesen | Unterhaltungen ohne zuständige Person |
| Mail / Mehr | Alle E-Mails | E-Mails aus allen Anbieterordnern außer Papierkorb und Junk |
| Mehr | Letzte Aktivität | Kürzlich geänderte Unterhaltungen |
| Mail | Geplant | Nachrichten, die auf eine spätere Zustellung warten |

Anbieterordner bilden eine andere Ebene. Wenn du eine Unterhaltung in Archiv, Papierkorb, Junk oder einen anderen Anbieterordner verschiebst, ändert sich die entfernte Ablage. Die Änderung kann in anderen E-Mail-Programmen sichtbar sein. Wenn du eine Unterhaltung als **Erledigt** markierst, ändert sich nur der Cloud-Nachverfolgungsstatus. Die E-Mail wird weder archiviert noch verschoben.

Verwende **Wartet auf Antwort**, wenn der nächste Schritt deines Teams von einer anderen Person abhängt. Mail setzt diesen Status, nachdem der Versand einer menschlichen Antwort oder Antwort an alle bestätigt wurde. Das gilt auch für Antworten, die aus einem anderen E-Mail-Programm synchronisiert werden. Verwende **Zurückstellen bis**, wenn die nächste Prüfung von einem Datum oder einer Uhrzeit abhängt. Zurückgestellte Unterhaltungen bleiben bis zum gewählten Zeitpunkt aus aktiven Ansichten ausgeblendet, sofern nicht vorher eine neue E-Mail eingeht.

Neue eingehende E-Mails setzen eine Unterhaltung immer auf **Handlungsbedarf** und beenden ihre Zurückstellung. Eine menschliche Antwort oder Antwort an alle setzt sie erst auf **Wartet auf Antwort**, wenn die Zustellung bestätigt wurde. Neue Nachrichten, Weiterleitungen, automatische Antworten, Wiederholungen und unklare Zustellungsergebnisse leiten keinen neuen nächsten Schritt ab. Unter **Unterhaltungsdetails** entscheidest du nur, ob die Unterhaltung **Erledigt** ist. Wenn du Erledigt entfernst, öffnet Mail sie wieder und leitet den nächsten Schritt aus der letzten bestätigten Nachricht ab.

Mit **In Ordner verschieben** in den Unterhaltungsaktionen oder Mail-Befehlen wählst du das Ziel per Tastatur, Zeigegerät oder Berührung. Auf dem Desktop kannst du eine Unterhaltungszeile außerdem auf einen auswählbaren Ordner in der linken Navigation ziehen. Mail merkt die Verschiebung vor; die Synchronisierung bestätigt das Ergebnis beim Anbieter.

Aktiviere die Kontrollkästchen, um mehrere Unterhaltungen zu bearbeiten. Halte die Umschalttaste gedrückt und wähle ein weiteres Kontrollkästchen oder eine weitere Unterhaltungszeile, um den geladenen Bereich dazwischen auszuwählen. Mail begrenzt eine Auswahl auf 50 Unterhaltungen, damit die Anbieterarbeit nachvollziehbar bleibt. Über die Auswahlleiste kannst du die ausgewählten Unterhaltungen als gelesen oder ungelesen markieren, kennzeichnen, archivieren, verschieben, als Junk einstufen oder löschen. Können nur einige Befehle vorgemerkt werden, bleiben die fehlgeschlagenen Unterhaltungen ausgewählt und Mail meldet jeden Fehler ausdrücklich.

## Einen vollständigen Verlauf lesen {icon="route"}

Wähle eine Unterhaltungszeile, um ihren Verlauf zu öffnen. Jede Nachricht hat eigene Absender, Empfänger, Datum, Inhalt und Anhänge. Klappe eine ältere Nachricht auf, wenn du ihren vollständigen Inhalt benötigst.

Über den Nachrichten kann eine optionale Unterhaltungszusammenfassung in einer hervorgehobenen Karte erscheinen. Mit **Zusammenfassung bearbeiten** oder **Weitere Unterhaltungsaktionen > Zusammenfassung erstellen** pflegst du sie mit Markdown-Formatierung. Zusammenfassungen sind gemeinsamer Mail-Kontext und können auch von einer Automatisierung aktualisiert werden. Enthält die Unterhaltung nicht abgeschlossene Entwürfe, zeigt die Antwortaktion einen Hinweis. Öffne **Unterhaltungsdetails**, um Verfasser und Änderungszeit des neuesten Entwurfs zu sehen und ihn fortzusetzen.

Die Unterhaltungsdetails enthalten außerdem einen kleinen Abschnitt **Zugehörige E-Mails** für die gesamte Unterhaltung. Mail ordnet andere Unterhaltungen aus demselben Postfach danach, ob sie eine externe beteiligte Person oder denselben normalisierten Betreff teilen, und zeigt für jedes Ergebnis die passenden Gründe. Davon zu unterscheiden ist die Aktion **Zugehörige E-Mails** auf einer Kontaktkarte. Sie öffnet eine exakte Suche nach dieser einen beteiligten Person. Keine der beiden Funktionen leitet Ähnlichkeit aus Nachrichtentexten, Anhängen oder Kalenderterminen ab.

Beim Öffnen einer ungelesenen Unterhaltung markiert Mail sie als gelesen. Über **Weitere Unterhaltungsaktionen** kannst du sie wieder als ungelesen markieren, eine Markierung hinzufügen oder entfernen oder die Unterhaltung drucken. Eine von dir als ungelesen markierte Unterhaltung bleibt in bereits geöffneten Tabs ungelesen, bis du ihre Zeile bewusst erneut öffnest. Eine Live-Aktualisierung allein markiert sie nicht als gelesen.

Mail passt Nachrichtentexte standardmäßig an das aktuelle Farbschema an: sicheres HTML im hellen Modus und Klartext im dunklen Modus, sofern beide Fassungen verfügbar sind. Öffne die Aktionen einer einzelnen Nachricht und wähle **Als Klartext anzeigen** oder **Als HTML anzeigen**, um dies für diese Nachricht zu überschreiben. Einen dauerhaften Modus für diesen Browser wählst du unter **Einstellungen > Lesen > Standardformat für Nachrichten**.

HTML-Nachrichten behalten eine begrenzte Auswahl an Layout-, Typografie-, Farb-, Abstands- und Tabellenstilen. Skripte, Formulare, eingebettete Objekte, externe Stylesheets und andere aktive Inhalte werden entfernt. Externe Bilder bleiben zusätzlich blockiert, bis du sie ausdrücklich lädst.

Die oberen Aktionen wirken auf die aktive Anbieterablage der Unterhaltung:

- **Archivieren** verschiebt sie in den zugeordneten Archivordner.
- **In Junk verschieben** verschiebt sie in den zugeordneten Junk-Ordner. In Junk wird dieselbe Aktion zu **Kein Spam** und verschiebt die Unterhaltung zurück in den Posteingang.
- **Löschen** verschiebt sie in den zugeordneten Papierkorb.

Diese Aktionen erfordern Schreibzugriff und die entsprechende Ordnerzuordnung. Meldet Mail, dass die Unterhaltung keine aktive Anbieterablage besitzt, aktualisiere das Postfach oder bitte eine Person mit Adminrechten, Ordnererkennung und Zuordnungen zu prüfen.

Wähle **Mail-Befehle** über der Unterhaltungsliste, um dieselben Aktionen zu durchsuchen, die in Schaltflächen und Menüs erscheinen. Häufige Befehle haben auch Tastaturkürzel. Unter **Tastaturkürzel konfigurieren** in den Mail-Befehlen kannst du sie auf diesem Gerät ändern oder deaktivieren. Kürzel werden nicht ausgeführt, während du in einem Eingabefeld oder Nachrichteneditor schreibst.

Öffne die **Organisationsaktionen** einer einzelnen Nachricht für Werkzeuge, die sich auf den Absender beziehen:

- **Alle von diesem Absender suchen** öffnet eine exakte, URL-gestützte Postfachsuche.
- **Regel aus Absender erstellen**, **Absender blockieren** und **Absenderdomain blockieren** öffnen den geführten Regeleditor mit bereits eingetragenem Absender.
- **Abbestellung verwalten** erscheint nur, wenn die Nachricht standardisierte Angaben zum Abbestellen einer Mailingliste enthält.

## Eine einzelne Nachricht untersuchen {icon="file-search"}

Öffne **Unterhaltungsdetails**, klappe **E-Mail-Details** auf und wähle **Header** oder **Quelle**, wenn du technische Angaben zu einer Nachricht benötigst. Wähle bei einer Unterhaltung mit mehreren Nachrichten oben im Inspektor die genaue Nachricht aus.

- **Übersicht** zeigt Nachrichten-IDs, Anbieterablage, Standardmarkierungen, Anbieter-Schlüsselwörter, MIME-Teile, Anhänge, Synchronisierungsstatus und mögliche Analysewarnungen.
- **Spam-Diagnose** zeigt vorhandene Spam-Header des Anbieters. Cloud berechnet oder erschließt keinen eigenen Spamwert.
- **Header** zeigt jeden gespeicherten Header, einschließlich wiederholter Zustellungsheader.
- **Quelle** zeigt eine begrenzte Vorschau der exakten ursprünglichen Nachricht. Wähle **.eml herunterladen**, um die vollständige bytegenaue Datei zu erhalten.

Eine `.eml`-Datei ist hilfreich, um eine einzelne Nachricht in ein anderes E-Mail-Programm zu übertragen, ein Zustellungsproblem zu melden oder die ursprüngliche Nachricht für eine Untersuchung aufzubewahren. Das Öffnen des Inspektors ändert weder die Nachricht noch ihren Anbieterzustand.

Anbieter-Schlüsselwörter bleiben für Kompatibilität und Diagnose im Inspektor sichtbar. Verwende lokale Tags für normale Kennzeichnungen. Mail bietet in Nachrichten- und Unterhaltungsmenüs keine Bearbeitung von Anbieter-Schlüsselwörtern an.

Unverarbeitete Header und `.eml`-Dateien können private Adressen, Servernamen, Routingangaben, Ergebnisse der Absenderprüfung und den vollständigen Nachrichtentext enthalten. Prüfe sie vor dem Teilen. Bei älteren oder nur teilweise synchronisierten Nachrichten kann der lesbare Inhalt verfügbar sein, obwohl die exakte ursprüngliche Quelle fehlt. Der Inspektor erklärt in diesem Fall, dass Quelle und `.eml`-Download nicht verfügbar sind.

## Mailinglisten verwalten {icon="news"}

Mail erkennt Mailinglisten anhand der standardisierten Listeninformationen in empfangenen Nachrichten. Jede Person mit Leserechten für das Postfach kann unter **Postfachwerkzeuge > Mailinglisten** die erkannten Listen, ihr letztes Nachrichtenaufkommen, ihre neueste Nachricht und die von der Liste angebotenen Aktionen sehen.

Die verfügbaren Aktionen richten sich nach den Angaben des Absenders. Abbestell- und Aufräumaktionen erfordern Schreib- oder Adminrechte. Personen mit Leserechten können Listen prüfen und deren angebotene Archiv- oder Beitragslinks öffnen.

- **Abbestellen** fordert die Liste auf, keine weiteren E-Mails zu senden. Unterstützt die Liste eine geschützte Ein-Klick-Anfrage, verwendet Mail sie. Andernfalls öffnet Mail die Abbestellseite der Liste oder bereitet die dafür vorgesehene Abbestell-E-Mail vor.
- **An Liste schreiben** öffnet die für neue Listennachrichten angegebene Adresse.
- **Listenarchiv** öffnet das von der Liste angegebene Archiv.
- Nach einer Ein-Klick-Abbestellung kannst du mit **Vorhandene archivieren** oder **Vorhandene in den Papierkorb verschieben** jeweils bis zu 500 bereits synchronisierte Nachrichten verschieben. Wiederhole die Aktion, wenn Mail meldet, dass weitere Nachrichten vorhanden sind.

Prüfe den Listennamen vor dem Abbestellen. Die Anfrage betrifft künftige Zustellungen an dieses Postfach und lässt sich möglicherweise nur schwer rückgängig machen. Sie löscht keine vorhandenen Nachrichten. Mail kann nicht garantieren, wann ein externer Listenanbieter die Zustellung beendet.

Mail öffnet niemals einen Abbestelllink, nur weil du eine Nachricht in der Vorschau ansiehst oder liest. Listen ohne standardisierte Listeninformationen erscheinen nicht unter **Mailinglisten**.

## Anhänge öffnen und auf eine Nachricht antworten {icon="paperclip"}

Empfangene Anhänge bleiben mit der Nachricht verbunden, mit der sie eingegangen sind. Wähle einen Anhang, um ihn in einem neuen Browser-Tab zu öffnen oder herunterzuladen.

Personen mit Postfach-Adminrechten können außerdem einen öffentlichen Download-Link für einen Anhang erstellen. Die URL wird nur bei der Erstellung angezeigt und kann durch Passwort, Ablaufzeit und eine Höchstzahl an Download-Sitzungen geschützt werden. Bestehende Links verwaltest oder widerrufst du unter **Postfachwerkzeuge > Geteilte Links**.

## Externe Bilder steuern {icon="photo-shield"}

Mail blockiert Bilder, die eine Nachricht andernfalls von einem externen Server laden würde. Das Laden eines solchen Bildes kann dem Absender mitteilen, dass die Nachricht geöffnet wurde. Direkt in die Nachricht eingebettete Bilder bleiben sichtbar.

Enthält eine Nachricht blockierte Bilder, kannst du wählen:

- **Bilder laden**, um sie nur für diese geöffnete Nachricht zu laden.
- **Immer für Absender**, um Bilder in künftigen Nachrichten von genau dieser Adresse zu erlauben.
- **Immer für Domain**, um Bilder von allen Adressen dieser Domain zu erlauben. Verwende diese umfassendere Option nur für eine Domain, der du vertraust.

Diese Einstellungen gelten nur für dich im aktuellen Postfach. Sie ändern nicht, was andere Personen im Team sehen. Unter **Postfachwerkzeuge > Externe Bilder** kannst du gespeicherte Einstellungen prüfen oder entfernen.

Mail ruft erlaubte Bilder über seinen geschützten Bilddienst ab, statt die Bildadresse deinem Browser mitzuteilen. Der externe Server kann weiterhin erkennen, dass sein Bild angefordert wurde. Lass Bilder daher bei unbekannten oder verdächtigen Absendern blockiert.

Unter einer aufgeklappten Nachricht kannst du wählen:

- **Antworten**, um dem Absender zu antworten.
- **Allen antworten**, um die ursprünglichen Empfänger einzubeziehen.
- **Weiterleiten**, um eine weitergeleitete Nachricht zu beginnen. Vor der Erstellung des Entwurfs kannst du entscheiden, ob die ursprünglichen Anhänge enthalten sein sollen.
- **Als neue E-Mail verwenden**, um eine Nachricht in einen unabhängigen, prüfbaren Entwurf zu kopieren, ohne ihre Unterhaltung zu ändern oder sie sofort zu senden.
- **Auswahl zitieren**, nachdem du Text im Nachrichtentext markiert hast. Mail fügt die ausgewählten Zeilen als Zitat in eine Antwort ein, damit du direkt darunter antworten kannst.

Informationen zu Verfassen, Entwürfen, Anhängen, Signaturen und Zustellungsoptionen findest du unter [E-Mails verfassen und senden](/app/mail/help/mail-compose).

## Wiederverwendbare Ansichten und lokale Tags erstellen {icon="layout-list"}

Öffne **Einstellungen > Organisation**, um aus Ordner- und Zusammenarbeitsfiltern eine gespeicherte Ansicht zu erstellen. Eine Ansicht kann nach Ordner, zuständiger Person, nächstem Schritt, lokalem Tag und Zurückstellungsstatus filtern.

- **Nur für mich** erstellt eine private Ansicht.
- **Alle mit Postfachzugriff** erstellt eine Postfachansicht und erfordert Schreibzugriff.
- Die Sichtbarkeit steht nach der Erstellung fest. Erstelle eine Ersatzansicht, wenn du eine andere Sichtbarkeit benötigst.

Lokale Tags sind Postfachkennzeichnungen für Personen, Suche und Automatisierungen. Wähle in der linken Navigation unter **Tags** einen Tag aus, um alle passenden Unterhaltungen zu öffnen. Tags sind weder IMAP-Ordner noch Anbieter-Schlüsselwörter und erscheinen nicht in anderen E-Mail-Programmen. Wenn du einen lokalen Tag löschst, wird er aus jeder Unterhaltung dieses Postfachs entfernt.

## Unterhaltungsgruppierung korrigieren {icon="arrows-split-2"}

Verwende **Mit anderer Unterhaltung zusammenführen**, wenn zwei Cloud-Unterhaltungen zusammengehören. Wähle bei einer einzelnen Nachricht **Neue Unterhaltung mit dieser Nachricht beginnen**, wenn eine Antwort ein neues Thema einführt, oder **Nachricht in andere Unterhaltung verschieben**, wenn sie zu einem vorhandenen Verlauf gehört. Diese Aktionen erfordern Schreibzugriff und ändern die Unterhaltungsgruppierung in Cloud, nicht den Nachrichteninhalt.
