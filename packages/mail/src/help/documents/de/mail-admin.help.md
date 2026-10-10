---
id: mail-admin
title: Ein Postfach einrichten und verwalten
icon: ti ti-settings
description: Transport, Absenderidentitäten, Ordner, Zugriff, Automatisierung und Lebenszyklus eines Postfachs verwalten.
order: 50
---

Mit Zugriff **Verwalten** auf ein Postfach steuerst du die Verbindung zum Anbieter und die Cloud-Regeln dazu. Öffne **Einstellungen** in der Navigation des Postfachs.

## Persönliche und gemeinsame Einstellungen unterscheiden {icon="settings"}

Die Einstellungen sind nach Zweck gruppiert:

- **Lesen** steht allen zur Verfügung, die das Postfach lesen. Es legt fest, ob dieser Browser sicheres HTML oder reinen Text zeigt oder sich an das aktuelle Farbschema anpasst.
- **Organisation** steht mit Zugriff **Ansehen** für private gespeicherte Ansichten zur Verfügung. Mit Zugriff **Bearbeiten** erstellst du auch geteilte Ansichten und Tags des Postfachs.
- **Schreiben** steht mit Zugriff **Bearbeiten** oder **Verwalten** zur Verfügung. Es enthält persönliche Schreibeinstellungen, Vorlagen, Standardsignaturen und den Editor für das E-Mail-Design. Inhalte und Design für das ganze Postfach brauchen Zugriff **Verwalten**.
- **Allgemein** ist der erste Bereich, der Zugriff **Verwalten** braucht. Er legt die gemeinsame Identität und die Schutzregeln für den Versand fest.
- **Allgemein**, **Konten und Identitäten**, **Kalendereinladungen**, **Ordner**, **Zugriff** und **Gefahrenbereich** brauchen Zugriff **Verwalten**.

Wähle unter **Einstellungen → Kalendereinladungen** einen Space, in dem du Zugriff **Bearbeiten** hast, als vorgeschlagenes Ziel für importierte Einladungen. Mail speichert diese Einstellung für das ganze Postfach. Spaces bietet jeder Person nur Ziele an, in denen sie Zugriff **Bearbeiten** hat.

Die Einstellung importiert keine E-Mails automatisch. Jede Einladung kann in einen anderen Space gehen, in dem du Zugriff **Bearbeiten** hast. Du kannst die Auswahl gefahrlos leeren. Löscht jemand den Space oder endet dein Zugriff, behandelt Mail den Standard als nicht gesetzt.

Betriebsstatus und öffentliche Links zu Anhängen sind von den Einstellungen getrennt. Öffne sie über **Postfachwerkzeuge** in der Navigation des Postfachs.

## Verbindung überwachen und pausieren {icon="route"}

**Postfachwerkzeuge → Postfachstatus** zeigt den Zustand des Transports, das verbundene Konto, die Ordnererkennung, die Synchronisierung und den Stand des Suchindex.

- **Jetzt synchronisieren** reiht eine Synchronisierung des Postfachs ein. **Letzte erfolgreiche Synchronisierung** zeigt, wann die letzte abgeschlossen wurde. **Jetzt synchronisieren** ist nicht verfügbar, solange das Postfach pausiert ist oder sein Konto zuerst verbunden, neu verbunden oder geprüft werden muss.
- **Ordner neu ermitteln** aktualisiert die Ordner und die Angaben zum Namensraum beim Anbieter.
- **Verbindung prüfen** schließt eine ausstehende Verbindung zum Anbieter ab.
- **Postfach pausieren** stoppt die eingehende Synchronisierung, eingereihte Änderungen beim Anbieter, geplante Zustellungen und automatische Antworten.
- **Postfach fortsetzen** lässt diese Hintergrundvorgänge weiterlaufen.

Pausieren stoppt Vorgänge. Es blendet nichts aus. Vorhandene gespiegelte E-Mails und Daten der Zusammenarbeit bleiben für alle mit Zugriff auf das Postfach lesbar.

### Projektionen und fehlgeschlagene Vorgänge reparieren

Mit Zugriff **Verwalten** startest du unter **Postfachwerkzeuge → Postfachstatus → Erweiterte Diagnose und Reparatur** Reparaturen im Hintergrund. Erneutes Laden von Inhalten, Neuaufbau der Suche, Reparatur der Unterhaltungen, Neuaufbau von Ordnern, Neuermittlung und Synchronisierung sind dauerhafte Befehle. Das Schließen des Dialogs stoppt sie nicht. Bevor ein Befehl läuft, prüft Mail erneut, ob du noch Zugriff **Verwalten** hast.

Die Aktionsschaltflächen zeigen, was gerade möglich ist. Eine ausgeschaltete Aktion nennt den Grund, etwa eine pausierte Synchronisierung, einen inaktiven Ordner oder dieselbe Arbeit, die schon aussteht.

- **Suche neu aufbauen** ersetzt nur die abgeleiteten Suchabschnitte.
- **Unterhaltungsansicht reparieren** verknüpft verwaiste Nachrichten und aktualisiert Zusammenfassungen. Es entfernt Kopien eigener Mail-Entwürfe, die eine frühere Synchronisierung als Nachrichten importiert hat. Manuelle Zuordnungen von Unterhaltungen, Kommentare, Referenzen, Zuweisungen und der Zustand der Unterhaltungen bleiben erhalten.

Ist das Ergebnis eines Befehls beim Anbieter unklar, bietet Mail nur **Anbietervorgang abgleichen** an. Der Abgleich prüft den Zustand beim Anbieter, bevor er das Ergebnis festlegt. Mail bietet keinen blinden neuen Versuch an, wenn ein Vorgang beim Anbieter schon begonnen haben könnte. Ein blinder neuer Versuch könnte die Aktion doppelt ausführen. **Vorgang erneut versuchen** und **Vorgang abbrechen** gibt es nur für Wartungsbefehle, die beim Anbieter lesen und deren Wirkung beim Anbieter nicht begonnen hat.

Die Cloud-Administration sieht dieselbe geschwärzte Zusammenfassung unter **Administration → Mail**. Sie enthält Zahlen, Zustände, Zeitstempel, verfügbare Capabilities, IDs und Fehlercodes. Sie enthält keine Betreffzeilen, Adressen, Nachrichtentexte, Anhangsnamen, Anbieter-Endpunkte, Zugangsdaten oder rohen Fehler des Anbieters.

## Die Verbindung zum Anbieter verwalten {icon="user-cog"}

**Einstellungen → Konten und Identitäten → Verbundenes Konto** enthält die aktuellen Zugangsdaten für ein- und ausgehende E-Mails. Mail prüft beide Protokolle, bevor es neue oder ersetzte Zugangsdaten speichert.

:::steps
1. Wähle zuerst **Einstellungen suchen**.
2. Ist die Erkennung nicht verfügbar oder falsch, gib die **Servereinstellungen** selbst ein.
3. Gib ein Passwort oder App-Passwort ein, das der Anbieter akzeptiert.
:::

Mail verschlüsselt die Zugangsdaten und kann sie nach dem Speichern nicht anzeigen. Um sie zu ersetzen, nutze **Konto bearbeiten**. Mail bietet keine Autorisierung im Browser für Google oder Microsoft an.

Mail meldet die Prüfung von IMAP und SMTP getrennt. Ein IMAP-Fehler blockiert die Synchronisierung, ein SMTP-Fehler den Versand. Behebe den gemeldeten Transport, bevor du es erneut versuchst.

Verbindest du ein Konto mit **Diese Adresse zum Senden verwenden**, verbindet Mail zuerst den Empfang und richtet dann die Standard-Absenderidentität ein. Schlägt nur der Schritt für den Versand fehl, zeigt das verbundene Konto **Empfang verbunden, Versand ist noch nicht eingerichtet** mit dem Grund. Der Empfang funktioniert weiter. Wähle **Versand einrichten**, um es mit der vorhandenen Verbindung erneut zu versuchen. Du musst das Konto nicht neu verbinden und das Passwort nicht erneut eingeben.

Meldet Mail **Synchronisierung läuft**, nutzt gerade die Synchronisierung oder ein anderer Vorgang beim Anbieter das Konto. Warte einen Moment und versuche es erneut. Der Verbindungsdialog behält deine Eingaben.

Entfernst du die Verbindung, stoppt der Transport. E-Mails beim Anbieter und die aufbewahrten Daten des Cloud-Postfachs bleiben.

## Absenderidentitäten verwalten {icon="send"}

**Einstellungen → Konten und Identitäten → Absenderidentitäten** steuert die Versandkontexte, die andere im Team nutzen können. Nutze getrennte Absenderidentitäten, wenn dieselbe Adresse für Rollen wie private E-Mails, Arbeit an der Universität oder ein Unternehmen andere Standards braucht.

Die **Bezeichnung der Absenderidentität** ist nur im Postfach sichtbar. Empfänger sehen den **Anzeigename** und die **Absenderadresse**. Jede Absenderidentität kann auch festlegen:

- Antwortadresse sowie Standard-Empfänger für Cc und Bcc;
- Nachrichtenformat, Priorität und Bestätigungsanfragen;
- eine Standardsignatur und eine Kontaktkarte;
- die Ordner für Gesendet und Entwürfe;
- ob sie die Standard-Absenderidentität ist.

**Erweiterte Zustellung** enthält anbieterspezifische Einstellungen. Lass sie in den meisten Fällen unverändert. Die optionale **Return-Path-Adresse** empfängt technische Zustellfehler und Unzustellbarkeitsberichte. Lass sie leer, außer dein E-Mail-Anbieter verlangt ausdrücklich eine eigene Adresse. Mail hängt die Kontaktkarte als `.vcf`-Datei an Nachrichten, die mit der Absenderidentität gesendet werden.

Nach einem Versand legt Mail die Nachricht im Ordner Gesendet der Absenderidentität ab, sobald es die Kopie dort speichert oder findet. Mail wartet nicht auf die nächste Synchronisierung.

- **Gmail:** Gmail speichert jede Nachricht, die über seinen eigenen SMTP-Server gesendet wird, in Gesendet. Mail sucht einige Minuten nach der Gmail-Kopie und fügt nur dann eine eigene hinzu, wenn es keine findet.
- **Andere Anbieter:** Mail fügt eine Kopie hinzu, außer **Anbieter speichert gesendete E-Mails automatisch** ist eingeschaltet. Dann sucht Mail nur direkt nach dem Versand nach der Kopie des Anbieters. Eine Kopie, die der Anbieter später auflistet, erscheint mit der nächsten Synchronisierung des Ordners.

:::warning Schalte Anbieter speichert gesendete E-Mails automatisch nur ein, wenn es zutrifft
Speichert der Anbieter gesendete Nachrichten nicht, gibt es keine Kopie.
:::

Mail fügt die Standard-Empfänger für Cc und Bcc hinzu, wenn jemand mit dieser Absenderidentität eine neue Nachricht, Antwort oder Weiterleitung beginnt. Mail entfernt Duplikate und Adressen, die schon unter An, Cc oder Bcc stehen. Automatische Antworten und Workflow-Nachrichten bekommen diese Standards nicht, und die schreibende Person kann sie vor dem Senden entfernen.

Mail fügt eine Postfachsignatur in neue Nachrichten, Antworten und Weiterleitungen ein. Wechselst du später die Absenderidentität, ändert das einen bearbeiteten Entwurf nicht. Eine persönliche Signatur hat Vorrang.

Unter **Einstellungen → Allgemein** trägst du vertrauenswürdige interne E-Mail-Domains ein und legst fest, ab wann Mail vor vielen Empfängern warnt. Vor externen Empfängern warnt Mail nur, wenn mindestens eine interne Domain eingetragen ist. Diese Einstellungen leiten die letzte Prüfung vor dem Versand. Sie blockieren keine legitime Zustellung und ändern keine Empfänger automatisch.

Priorität und Bestätigungsanfragen sind Vorschläge an andere E-Mail-Systeme:

- **Priorität** mit **Hoch** oder **Niedrig** fügt Standard-Header für die Wichtigkeit hinzu. Das Programm des Empfängers entscheidet, wie es sie zeigt.
- **Zustellbestätigungen anfordern** bittet den Sendeserver um einen Zustellbericht. Die Option gibt es nur, wenn der gewählte SMTP-Transport DSN-Unterstützung meldet.
- **Lesebestätigungen anfordern** bittet das E-Mail-Programm des Empfängers um eine Rückmeldung. Der Empfänger oder seine Organisation kann sie ignorieren oder ablehnen.

Empfangene Berichte erscheinen in der Aktivität der Unterhaltung als gemeldete Ergebnisse. Sie sind nützliche Hinweise für den Betrieb, aber kein Beweis, dass eine Person eine Nachricht gelesen oder bearbeitet hat.

Eine Absenderidentität nutzt normalerweise den SMTP-Server des Postfachs. Richte einen eigenen SMTP-Server nur ein, wenn die Absenderadresse einen anderen authentifizierten Einlieferungsserver nutzen muss. Mail verschlüsselt die eigenen Zugangsdaten, und niemand kann sie wieder lesen. Mail prüft den Server vor dem Speichern. Geplante Sendungen bleiben an die geprüfte Version des Transports gebunden, damit eine Änderung oder Entfernung dieses Transports eine bereits eingereihte Nachricht nicht still umleiten kann.

Zwei Absenderidentitäten können bewusst dieselbe Absenderadresse nutzen. Mail hält ihre Bezeichnungen, Standard-Empfänger, Signaturen, Antwortadressen, Zustelloptionen, Transporte, Ordnerzuordnungen und Prüfstatus getrennt. Passt eine Antwort genau zu einer Absenderidentität, wählt Mail sie automatisch. Sind mehrere passende Absenderidentitäten gleich gültig, muss die schreibende Person eine wählen.

Prüfe jede Absenderidentität: Wähle das verbundene Konto und einen Empfänger für eine echte Prüfnachricht. Ist die Absenderidentität für den Versand bereit, hat der Anbieter diesen Test mit der genauen Absenderadresse und den erweiterten Zustelleinstellungen angenommen. IMAP-Zugriff auf Ordner allein beweist nicht, dass der Anbieter diese Versandeinstellungen erlaubt.

**Für automatische Antworten zulassen** ist von der Prüfung getrennt. Automatische Antworten können nur eine Absenderidentität nutzen, die für den Versand bereit ist und bei der diese Option eingeschaltet ist. Das Einschalten sendet allein nichts. Es braucht zusätzlich eine eingeschaltete automatische Antwort oder einen Workflow.

## Ordner beim Anbieter verwalten {icon="user-cog"}

**Ordner** zeigt die Hierarchie, die Mail beim verbundenen E-Mail-Anbieter gefunden hat. Mit Zugriff **Verwalten** kannst du:

- einen Ordner auf oberster Ebene im persönlichen Namensraum des Postfachs erstellen;
- einen Unterordner erstellen, wo der Anbieter es erlaubt;
- einen Ordner beim Anbieter umbenennen oder löschen, wo das erlaubt ist;
- Ordner beim Anbieter abonnieren oder das Abonnement beenden; und
- festlegen, wo die E-Mails jedes Ordners in Cloud Mail erscheinen.

Diese Einstellungen wirken auf Verschiedenes:

- **Wo E-Mails erscheinen** ist eine Cloud-Einstellung für alle im Postfach. **Überall** zeigt den Ordner in der Seitenleiste und seine E-Mails in Alle E-Mails und den Arbeitsansichten. **Nur im Ordner** behält den Ordner in der Seitenleiste. Unterhaltungen, deren E-Mails nur dort liegen, verschwinden aus Alle E-Mails, den Arbeitsansichten und deren Zählern. **Mir zugewiesen** und **Versandprobleme** zeigen sie weiter. **Ausgeblendet** nimmt den Ordner auch aus der Seitenleiste. Suche und gespeicherte Ansichten finden weiter jede Unterhaltung. Keine dieser Optionen beendet ein Abonnement, löscht den Ordner, ändert Zugriffe beim Anbieter oder entfernt synchronisierte E-Mails.
- **Beim Anbieter abonnieren** ändert das IMAP-Abonnement. Andere E-Mail-Programme können über dieses Abonnement entscheiden, welche Ordner sie zeigen.
- **Zugriff beim Anbieter** steuert der Anbieter. Cloud zeigt geteilte Ordner und Ordner anderer Nutzer nur, wenn das verbundene Konto sie sehen kann. Zerstörende Aktionen erlaubt Cloud nur, wenn der aktuelle Zugriff beim Anbieter sie erlaubt.
- Die Synchronisierung folgt dem eingerichteten Umfang des Postfachs und dem Zustand beim Anbieter. **Wo E-Mails erscheinen** ändert sie nicht.

:::warning Löschen entfernt den Ordner beim Anbieter
Mail bietet das Löschen nur für einen leeren Ordner ohne Unterordner an. Posteingang und andere geschützte Ordner kannst du nicht löschen.
:::

Ein Ordnervorgang ist dauerhaft. Verlässt du die Einstellungen, bricht er nicht ab. Mail prüft den Zustand beim Anbieter erneut, bevor es das Ergebnis bestätigt.

**Ordner** zeigt die Hierarchie als kompakten Baum:

- Ordnergruppen wie `[Gmail]` bei Gmail erscheinen als Gruppenzeilen mit ihren Ordnern darunter.
- Der Pfeil neben einem Ordner klappt seine Unterordner ein.
- Ein Ordner, dessen Name mehrmals vorkommt, zeigt seinen Pfad.
- Wähle einen Ordner, um sein Menü zu öffnen. Das Menü erklärt die drei Optionen und enthält die Aktionen des Ordners, etwa **Neuer Unterordner**, **Umbenennen**, das Abonnement beim Anbieter, **Aus Mail entfernen** und **Ordner löschen**.
- Eine Zeile nennt ihre Option nur, wenn sie nicht **Überall** ist. **Nicht verfügbar** und **Prüfung erforderlich** kennzeichnen Probleme beim Anbieter.

Ein Unterordner folgt seinem übergeordneten Ordner, wenn dessen Option strenger ist. Er kann mehr E-Mails im Ordner halten, nie weniger. Seine Zeile zeigt dann „geerbt von“ und den Namen des übergeordneten Ordners. Sein Menü nennt den Ordner, der die offeneren Optionen festlegt. Wählst du wieder die Option des übergeordneten Ordners, folgt der Unterordner ihm wieder.

Gesendet, Entwürfe, Papierkorb, Spam und Sammlungen des Anbieters wie All Mail, Wichtig und Markiert bei Gmail entscheiden nie, wo E-Mails erscheinen. Mail bietet für sie deshalb **Nur im Ordner** nicht an, und **Nur im Ordner** an einem übergeordneten Ordner ändert sie nicht. Nur **Ausgeblendet**, an ihnen selbst oder am übergeordneten Ordner gesetzt, nimmt sie aus der Seitenleiste.

**Zuordnung besonderer Ordner** steht unter der Ordnerhierarchie. Sie legt die aktiven, auswählbaren Ordner fest, die Mail für Gesendet, Entwürfe, Archiv, Papierkorb und Spam nutzt. Den Posteingang findet Mail beim Anbieter. Eine falsche oder fehlende Zuordnung kann verhindern, dass die passende Aktion an der Unterhaltung oder die Ansicht von Gesendet oder Entwürfen abgeschlossen wird.

Zeigt das IMAP-Konto geteilte Ordner oder Ordner anderer Nutzer, kann **Ordner neu ermitteln** sie in dieselbe Hierarchie aufnehmen. Sie sind Zustand des verbundenen Kontos beim Anbieter, keine eigenen Cloud-Ressourcen. Cloud kann nicht:

- einzelne Ordner teilen;
- Zugriffslisten beim Anbieter bearbeiten;
- gleichnamige Ordner aus mehreren Konten zusammenführen;
- die Zugangsdaten einer anderen Person nutzen, wenn diese Verbindung den Zugriff verliert.

Änderungen beim Anbieter an Namensräumen, Abonnements oder Zugriff können einen Ordner nicht verfügbar oder unklar machen. Prüfe **Postfachwerkzeuge → Postfachstatus**, korrigiere bei Bedarf den Zustand beim Anbieter und führe dann **Ordner neu ermitteln** aus.

Ist ein nicht verfügbarer Ordner endgültig weg, wähle in seinem Menü **Aus Mail entfernen**. Nach der Bestätigung entfernt Mail den nicht verfügbaren Ordner und seine nicht verfügbaren Unterordner aus seiner Ordnerliste. Beim Anbieter wird nichts gelöscht, und gespiegelte Nachrichten und Verlauf bleiben. Zeigt der Anbieter den Ordner wieder, stellt ihn die nächste Neuermittlung automatisch wieder her.

Agenten ändern Abonnements beim Anbieter mit `cld mail folder subscribe` und `cld mail folder unsubscribe`. Beide Befehle erzeugen denselben dauerhaften, nachverfolgbaren Befehl beim Anbieter wie die Web-App.

## Zugriff festlegen {icon="shield-lock"}

**Zugriff** nutzt den normalen Zugriffseditor von Cloud. Gib den kleinsten Zugriff, den die Person für ihre Arbeit braucht:

- **Ansehen** zum Lesen, Suchen, Kommentieren und für persönliche Erinnerungen.
- **Bearbeiten** für den Versand, Vorgänge an E-Mails beim Anbieter und Änderungen an der Zusammenarbeit.
- **Verwalten** für Transport, Freigabe, Regeln, Workflows und den Lebenszyklus des Postfachs.
- **Nur zugewiesene ansehen** oder **Nur zugewiesene bearbeiten** für Personen und Gruppen, die nur an den ihnen zugewiesenen Unterhaltungen arbeiten. Was sie damit tun können, steht in [Gemeinsam in einem Postfach arbeiten](/app/mail/help/mail-collaboration).

**Verwaltungszugriff für automatische Antworten** ist eine Einstellung des Postfachs über der Zugriffsliste:

- **Personen mit Schreib- oder Verwaltungsrechten** lässt Personen mit Zugriff **Bearbeiten** geführte Abwesenheitsnotizen und Empfangsbestätigungen erstellen und ändern.
- **Nur Personen mit Verwaltungsrechten** ist der sichere Standard für neue und vorhandene Postfächer.

Diese Einstellung lässt Personen mit Zugriff **Bearbeiten** keine Absenderidentitäten, Einstellungen für Referenznummern oder YAML-Workflows ändern. Das bleiben Vorgänge, die Zugriff **Verwalten** brauchen.

Zugangsdaten bleiben verborgen, auch für Personen mit Zugriff **Verwalten**. Wer ein Postfach teilt, gibt Zugriff auf das Postfach in Cloud. Das Passwort oder Token beim Anbieter wird dabei nicht sichtbar.

## Anhänge über öffentliche Links teilen {icon="link"}

Du brauchst Zugriff **Verwalten** auf das Postfach, um einen öffentlichen Link zu einem Anhang zu erstellen, aufzulisten oder zu widerrufen. Öffne eine empfangene Nachricht oder einen Entwurf und nutze die Link-Aktion neben einem Anhang. Dateien über 100 MiB kannst du so nicht teilen.

:::warning Kopiere die URL, bevor du das Ergebnis schließt
Die öffentliche URL erscheint nur einmal, direkt nach dem Erstellen. Mail speichert nur einen Hash ihres geheimen Tokens und kann dieselbe URL nicht noch einmal zeigen.
:::

**Postfachwerkzeuge → Freigabelinks** listet alle Links seitenweise, auch ältere aktive Links. Dort widerrufst du den Zugriff, ohne die ursprüngliche Nachricht oder den Anhang des Entwurfs zu löschen.

Ein Link kann ein optionales Passwort, einen Ablaufzeitpunkt und eine Höchstzahl an Download-Sitzungen haben. Passwörter unterscheiden Groß- und Kleinschreibung und können Leerzeichen enthalten. Bereichsanfragen, die einen erlaubten Download fortsetzen, zählen nicht als weitere Downloads. Widerrufene, abgelaufene, aufgebrauchte, ungültige und mit falschem Passwort aufgerufene Links schlagen fehl, ohne Metadaten des Anhangs zu verraten.

Die CLI bietet dieselben Vorgänge über `cld mail attachment link create`, `list` und `revoke`. Übergib ein Passwort über `--password-file` oder `--password-stdin`. Die CLI nimmt es nie als sichtbaren Wert in der Befehlszeile an.

## Mail-Speicher prüfen {icon="database"}

Nur die Cloud-Administration kann **Administration → Mail** öffnen. Zugriff **Verwalten** auf ein Postfach reicht nicht. Die Seite listet jedes aktive Postfach mit geschwärzten Angaben zu Zustand, Synchronisierung, Speicher, Zahl der Zugriffseinträge und Handlungsbedarf. Sie zeigt nie Inhalte von Nachrichten oder Anhängen.

Öffne auf dieser Seite **Sicherheit**, um gemeldete verdächtige Nachrichten zu prüfen und genaue organisationsweite Schutzregeln zu pflegen. Was Nutzer sehen und wie sichere Regeln aussehen, steht unter [Verdächtige E-Mails erkennen und melden](/app/mail/help/mail-security).

Nutze **Berechtigungen verwalten** an einem Postfach, um ein Postfach ohne verwaltende Person wiederherzustellen oder einen versehentlichen Zugriffseintrag zu korrigieren. Das ist eine ausdrückliche, protokollierte Änderung des Zugriffs. Die Cloud-Administration erhält nicht automatisch Zugriff auf Inhalte des Postfachs. Füge eine neue verwaltende Person hinzu, bevor du die letzte Person mit Zugriff **Verwalten** entfernst.

Die CLI bietet dieselben Werkzeuge zur Wiederherstellung:

- `cld mail admin mailbox list` findet Postfächer, auch solche, die die aktuelle Administration nicht öffnen kann.
- `cld mail admin mailbox get <mailbox>` zeigt einen geschwärzten Betriebsdatensatz.
- `cld mail admin mailbox access list|grant|set|revoke <mailbox>` ändert direkten Zugriff für Nutzer, Gruppen oder Dienstkonten.
- `cld mail admin storage show|reconcile` liest oder aktualisiert die Speicherdaten.

**Speicherbestand aktualisieren** reiht einen Abgleich im Hintergrund ein. Die Seite und `cld mail admin storage show` zeigen bis zum Ende dieses Auftrags weiter den letzten abgeschlossenen Stand. Das Einreihen aktualisiert die Zahlen nicht sofort. Diese Werte sind Betriebsdaten, keine Speicherkontingente, und sie erlauben keinen Blick in Inhalte.

## Kontaktverzeichnis wählen {icon="address-book"}

Mail nutzt die eingebaute App Contacts für Empfängervorschläge, Kontakte in den **Unterhaltungsdetails**, **Neuer Kontakt** und Kontakte, die **Mit KI schreiben** anhängt. Dafür musst du nichts einrichten.

Um eine andere App zu nutzen, etwa eine App für Kundenbeziehungen, musst du zur Cloud-Administration gehören:

:::steps
1. Öffne **Administration → Mail**. **Kontaktverzeichnis** zeigt die aktuelle App und ob sie den Contacts-Standard oder eine eigene Zuordnung nutzt.
2. Wähle **Konfigurieren**, um den Editor zu öffnen.
3. Wähle die App.
4. Wähle für jede Funktion eine ihrer Capabilities.
5. Wähle **Speichern**.
:::

Jede Liste bietet nur Capabilities an, die zum Vertrag für Kontaktverzeichnisse passen. Stellt die App Standardwerte bereit, trägt Mail sie ein.

- **Empfänger vorschlagen** und **Beteiligte zuordnen** sind Pflicht.
- **Kontakt lesen** ist optional. Ohne diese Funktion meldet **E-Mail verfassen** aus einem Kontakt in einer anderen App, dass der Kontakt nicht verfügbar ist.
- **Beschreibbare Bücher auflisten** und **Kontakt anlegen** sind optional und gehören zusammen. Ohne sie blendet Mail **Neuer Kontakt** aus.

**Speichern** prüft jede Auswahl gegen die aktuellen Capabilities der App und nennt jedes Feld, das Mail nicht nutzen kann. Mail ruft die App immer mit dem eigenen Zugriff jeder Person auf, sodass jede Person dort nur die Kontakte sieht, die sie lesen darf. Stoppt die App oder ändert sie sich später unverträglich, werden die betroffenen Funktionen nicht verfügbar, wie wenn Contacts nicht verfügbar ist. **Contacts-Standard verwenden** stellt die eingebaute Zuordnung wieder her.

`cld mail admin contact-directory show|candidates|set|reset` macht dasselbe im Terminal und nutzt dieselbe Prüfung. Mail speichert keine unverträgliche Zuordnung, und der Befehl listet dieselben Probleme.

## Signaturen und E-Mail-Design einrichten {icon="pencil"}

Erstelle unter **Einstellungen → Schreiben** private Signaturen und Textbausteine oder solche für das Postfach. Lege die Standardsignatur des Postfachs unter **Konten und Identitäten → Absenderidentitäten** fest. Ein persönlicher Standard einer Person unter **Schreiben** hat Vorrang.

Markdown-Nachrichten bekommen immer das eingebaute lesbare E-Mail-Design. **E-Mail-Design** ergänzt geprüftes CSS des Postfachs für das Firmendesign. Es ersetzt nicht das sichere Grunddesign. Prüfe das Ergebnis in der **Vorschau** des Editors, bevor du dich auf eine CSS-Änderung verlässt.

## Automatische Antworten und Referenzen einrichten {icon="settings"}

Öffne **Postfachwerkzeuge → Automatisierungen**:

:::steps
1. **Übersicht** zeigt, was aktiv ist, und öffnet genau die passende Einrichtung.
2. **Automatische Antworten** bietet die Vorlagen **Abwesenheitsnotiz**, **Empfangsbestätigung zu Bürozeiten**, **Empfangsbestätigung mit Referenznummer** und **Eigene automatische Antwort**. Personen mit Zugriff **Bearbeiten** nutzen diesen Bereich, wenn die Zugriffseinstellung es erlaubt.
3. **Eingehende E-Mails** bietet geführte Bedingungen und einen Ablauf, der Mail- und KI-Schritte mischt.
4. **Aktivität** zeigt Workflow-Läufe und Nachbearbeitungen von Automatisierungen für eingehende E-Mails in diesem Postfach.
5. **Workflows** enthält versionierte YAML-Definitionen, die Einrichtung der Referenznummern und ausdrückliche Steuerung der Aktivierung.
:::

**Eingehende E-Mails**, **Aktivität** und **Workflows** brauchen Zugriff **Verwalten**. Mail speichert den Zeitplan einer automatischen Antwort direkt in der geführten Antwort oder in der unveränderlichen Version des YAML-Workflows. Es gibt keine eigene Zeitplan-Ressource, die du abgleichen musst.

Eine automatische Antwort hat diese Einstellungen:

- ein oder aus und eine bestätigte Absenderidentität für Automatisierungen;
- Betreff, Text und das Format Markdown oder Nur Text;
- den Wiederholungsabstand pro Empfänger;
- Zeitzone, aktive Tage, wöchentliche Zeitfenster und Ausnahmen;
- das Verhalten außerhalb des aktiven Zeitfensters.

Für das Verhalten außerhalb des aktiven Zeitfensters wählst du:

- **Nicht antworten** ignoriert Nachrichten außerhalb des Zeitplans.
- **Im nächsten aktiven Zeitfenster antworten** verschiebt die Antwort, bis der Zeitplan aktiv ist.

Prüfe die genaue Antwort in der Vorschau, bevor du sie einschaltest. Das Pausieren des Postfachs stoppt automatische Antworten.

Einrichtungsschritte, Auswirkungen des Zeitplans, Referenzmuster und Schutz vor Wiederholungen findest du unter [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation).

## Workflows verwalten {icon="route"}

Öffne **Automatisierungen → Workflows** für den YAML-Editor. Speichern erzeugt eine neue unveränderliche Version. Diese Version wird nicht automatisch aktiviert.

:::steps
1. Prüfe YAML, Diagnosen der Validierung und Wirkungsbudgets.
2. Aktiviere die Version ausdrücklich.
3. Prüfe die Läufe des Postfachs getrennt unter **Automatisierungen → Aktivität**.
:::

Für normale Abwesenheitsnotizen und Empfangsbestätigungen nutzt du die Oberfläche für automatische Antworten. Nutze Workflows, wenn das Postfach feste Bedingungen und Aktionen über diesen Editor hinaus braucht.

Alle unterstützten Eingaben, Auslöser, Aktionen, Bedingungen, Ausdrücke, Standardwerte und geprüften Beispiele stehen in der [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows).

## Ein Postfach löschen und wiederherstellen {icon="point"}

**Gefahrenbereich → In „Kürzlich gelöscht“ verschieben** setzt das Postfach in einen gelöschten Zustand, den du wiederherstellen kannst. Mail löscht E-Mails beim Anbieter und aufbewahrte Cloud-Daten nicht endgültig.

Gelöschte Postfächer erscheinen in der Mail-Übersicht unter **Kürzlich gelöscht** für Personen, die sie wiederherstellen können. Ein wiederhergestelltes Postfach startet pausiert. Prüfe unter **Postfachwerkzeuge → Postfachstatus** Verbindung, Ordnererkennung und Zustand. Wähle dann **Postfach fortsetzen**.
