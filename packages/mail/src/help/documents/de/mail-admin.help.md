---
id: mail-admin
title: Ein Postfach einrichten und verwalten
icon: ti ti-settings
description: Verbindung, Identitäten, Ordner, Zugriff, Automatisierungen und Lebenszyklus verwalten.
order: 50
---

Personen mit Postfach-Adminrechten verwalten die Verbindung zum E-Mail-Anbieter und die gemeinsamen Cloud-Regeln. Öffne **Einstellungen** in der Postfachnavigation.

## Persönliche und gemeinsame Einstellungen unterscheiden {icon="settings"}

- **Lesen** ist persönlich und bestimmt Darstellung, Klartext sowie Anpassung an das aktuelle Farbschema.
- **Organisation** enthält persönliche gespeicherte Ansichten. Schreibberechtigte Personen können zusätzlich gemeinsame Ansichten und lokale Tags verwalten.
- **Allgemein** ist die erste Administrationskategorie. Sie steuert die gemeinsame Identität und Schutzmaßnahmen beim Senden.
- **Schreiben** enthält persönliche Vorgaben, Vorlagen und Signaturen. Postfachweite Inhalte und das E-Mail-Design erfordern Adminrechte.
- **Allgemein**, **Konten und Identitäten**, **Kalendereinladungen**, **Ordner**, **Zugriff** und **Gefahrenzone** sind Postfach-Administratoren vorbehalten.

Unter **Einstellungen > Kalendereinladungen** kann ein beschreibbarer Space als vorgeschlagenes Ziel für den Import gespeichert werden. Die postfachweite Einstellung importiert keine Einladung automatisch; jede Einladung kann in einen anderen beschreibbaren Space übernommen werden. Das Leeren der Auswahl ist sicher. Wird der Space gelöscht oder der Zugriff entzogen, behandelt Mail die Vorgabe als nicht gesetzt. Spaces liefert nur Ziele, in denen die aktuelle Person schreiben darf.

Betriebsstatus und öffentliche Anhangslinks gehören nicht zur Konfiguration. Öffne sie über **Postfachwerkzeuge** in der Postfachnavigation.

## Verbindung überwachen und pausieren {icon="route"}

**Postfachwerkzeuge > Postfachstatus** zeigt Verbindung, Ordnererkennung, Synchronisierung und Suchindex.

- **Jetzt synchronisieren** startet eine Synchronisierung.
- **Neu erkennen** aktualisiert Ordner und Namespaces.
- **Verbindung prüfen** schließt eine ausstehende Anbieterprüfung ab.
- **Postfach pausieren** stoppt Synchronisierung, vorgemerkte Anbieteränderungen, geplanten Versand und automatische Antworten.
- **Postfach fortsetzen** erlaubt diese Hintergrundarbeit wieder.

Das Pausieren ändert keine Leseberechtigung. Bereits gespiegelte E-Mails und Zusammenarbeitsdaten bleiben erreichbar.

### Abgeleitete Daten und fehlgeschlagene Arbeit reparieren

Unter **Postfachwerkzeuge > Postfachstatus > Erweiterte Diagnose und Reparaturen** stehen asynchrone, dauerhafte Befehle für Hydrierungswiederholung, Suchindex, Unterhaltungsprojektion, Ordner, Erkennung und Synchronisierung bereit. Das Schließen des Dialogs stoppt sie nicht. Vor der Ausführung werden die aktuellen Adminrechte erneut geprüft.

Die Aktionen spiegeln ihre aktuelle Verfügbarkeit. Eine deaktivierte Aktion nennt den Grund, etwa pausierte Synchronisierung, einen inaktiven Ordner oder bereits vorgemerkte gleichwertige Arbeit. Der Neuaufbau der Suche ersetzt nur abgeleitete Suchblöcke. Die Unterhaltungsreparatur verknüpft verwaiste Nachrichten und aktualisiert Zusammenfassungen; manuelle Überschreibungen, Kommentare, Referenzen, Zuweisungen und Unterhaltungsstatus bleiben erhalten.

Bei einem unklaren Anbietereffekt bietet Mail ausschließlich **Wirkung abgleichen** an. Eine blinde Wiederholung könnte eine Aktion doppelt ausführen. **Arbeit wiederholen** und **Arbeit abbrechen** erscheinen nur, wenn ihre Wirkung noch nicht begonnen hat.

Cloud-Administratoren sehen denselben bereinigten Gesamtstand unter **Administration > Mail**. Er enthält Anzahlen, Status, Zeitpunkte, verfügbare Funktionen, IDs und Fehlercodes, aber keine Betreffzeilen, Adressen, Nachrichtentexte, Anhangsnamen, Anbieterendpunkte, Zugangsdaten oder unverarbeiteten Anbieterfehler.

## Das Anbieterkonto verwalten {icon="user-cog"}

Unter **Konten und Identitäten > Verbundenes Konto** liegt die gemeinsame Eingangs- und Ausgangsverbindung. Mail prüft IMAP und SMTP, bevor neue Zugangsdaten gespeichert werden.

Verwende zunächst **Einstellungen suchen**. Öffne **Manuelle Servereinstellungen** nur, wenn die Erkennung nicht funktioniert oder falsche Angaben liefert. Ist in der Bereitstellung ein passender OAuth-Client für Google oder Microsoft eingerichtet, fahre im Autorisierungsfenster des Anbieters fort. OAuth-Zugriffs- und Aktualisierungstokens werden verschlüsselt und nie angezeigt. **Neu verbinden** eignet sich nach widerrufener Zustimmung; **Ersetzen** für Passwörter, App-Passwörter oder Tokens.

Mail meldet die IMAP- und SMTP-Prüfung getrennt. Eine fehlgeschlagene IMAP-Prüfung blockiert die Synchronisierung, eine fehlgeschlagene SMTP-Prüfung den Versand. Behebe den gemeldeten Transportfehler vor einem neuen Versuch. Das Entfernen der Verbindung trennt den Transport, löscht aber weder E-Mails beim Anbieter noch die in Cloud aufbewahrten Postfachdaten.

## Absenderidentitäten verwalten {icon="send"}

Unter **Einstellungen > Konten und Identitäten > Absenderidentitäten** werden die Versandkontexte für alle Personen im Postfach verwaltet. Verwende getrennte Identitäten, wenn dieselbe Adresse unterschiedliche Vorgaben für private, hochschulbezogene oder geschäftliche E-Mails benötigt.

Die **Identitätsbezeichnung** ist nur im Postfach sichtbar. Empfänger sehen **Anzeigename** und **Absenderadresse**. Eine Identität kann außerdem Reply-to, Standardempfänger für Cc und Bcc, Nachrichtenformat, Priorität, Empfangsbestätigungen, Standardsignatur, Kontaktkarte, Ordner für Gesendet und Entwürfe sowie ihren Standardstatus festlegen. Unter **Erweiterte Zustellung** stehen anbieterspezifische Angaben, die meist unverändert bleiben sollten. Die optionale **Return-path-Adresse** empfängt technische Zustellfehler und Bounce-Berichte; lasse sie leer, sofern dein Anbieter keine getrennte Adresse verlangt. Die Kontaktkarte wird als `.vcf` angehängt.

Standard-Cc- und -Bcc-Empfänger werden beim Erstellen einer neuen Nachricht, Antwort oder Weiterleitung mit dieser Identität ergänzt. Doppelte und bereits unter An, Cc oder Bcc vorhandene Adressen werden entfernt; die verfassende Person kann die Vorgaben vor dem Versand löschen. Automatische Antworten und Workflow-E-Mails übernehmen diese Empfänger nicht. Eine Postfachsignatur wird in neue Nachrichten, Antworten und Weiterleitungen eingefügt. Ein späterer Identitätswechsel schreibt einen bereits bearbeiteten Entwurf nicht um; eine persönliche Signaturvorgabe hat Vorrang.

Unter **Einstellungen > Allgemein** lassen sich vertrauenswürdige interne E-Mail-Domains und der Schwellwert für Warnungen bei großen Empfängergruppen festlegen. Warnungen vor externen Empfängern erscheinen nur, wenn mindestens eine interne Domain eingerichtet ist. Diese Regeln unterstützen die letzte Versandprüfung, blockieren aber keine berechtigte Zustellung und ändern keine Empfänger.

**Hohe** oder **Niedrige Priorität** fügt Standardkopfzeilen hinzu; das Programm des Empfängers entscheidet über die Anzeige. Eine **Zustellbestätigung** fordert einen Zustellstatusbericht an und ist nur verfügbar, wenn SMTP DSN-Unterstützung meldet. Eine **Lesebestätigung** fordert eine Empfangsbestätigung vom E-Mail-Programm des Empfängers an, die ignoriert oder abgelehnt werden kann. Eingehende Berichte erscheinen in der Unterhaltungsaktivität. Sie sind betriebliche Hinweise und kein Beweis dafür, dass eine Person die Nachricht gelesen oder bearbeitet hat.

Eine Identität verwendet normalerweise den SMTP-Server des Postfachs. Richte einen **Eigenen SMTP-Server** nur ein, wenn die Absenderadresse einen anderen authentifizierten Versandweg benötigt. Die Zugangsdaten sind verschlüsselt und nur schreibbar. Mail prüft den Server vor dem Speichern. Geplante E-Mails bleiben an die geprüfte Transportrevision gebunden; eine Änderung oder Entfernung kann eine eingereihte Nachricht nicht unbemerkt umleiten.

Zwei Identitäten dürfen dieselbe Absenderadresse verwenden und behalten trotzdem getrennte Bezeichnungen, Empfängervorgaben, Signaturen, Reply-to-Werte, Zustelloptionen, Transporte, Ordnerzuordnungen und Prüfstatus. Passt eine Antwort eindeutig zu einer Identität, wählt Mail sie automatisch. Bei mehreren gleichwertigen Treffern muss die verfassende Person ausdrücklich wählen.

Prüfe jede Identität mit dem verbundenen Konto und einem Empfänger für eine echte Prüfnachricht. **Versandbereit** bedeutet, dass der Anbieter diesen Test mit exakt der Absenderadresse und den erweiterten Zustelleinstellungen angenommen hat. IMAP-Ordnerzugriff allein belegt keine Versanderlaubnis. **Automatische Antworten erlauben** ist eine zusätzliche, separate Freigabe. Sie sendet selbst nichts; dafür wird weiterhin eine aktivierte automatische Antwort oder ein Workflow benötigt.

## Anbieterordner verwalten {icon="user-cog"}

Unter **Ordner** kannst du einen Ordner auf oberster Ebene oder bei entsprechender Anbieterberechtigung einen Unterordner erstellen, geeignete Anbieterordner umbenennen oder löschen, sie beim Anbieter abonnieren oder abbestellen und in der Cloud-Navigation ein- oder ausblenden.

- **In Mail anzeigen** ändert nur die Navigation.
- **Beim Anbieter abonnieren** ändert die IMAP-Subscription.
- Anbieterrechte bestimmen, welche gemeinsamen oder fremden Ordner sichtbar und veränderbar sind.
- Die Synchronisierung folgt dem Postfachumfang und wird nicht durch den Navigationsschalter gesteuert.

Nur leere, ungeschützte Ordner ohne Unterordner können beim Anbieter gelöscht werden. Ein dauerhafter Ordnervorgang läuft nach Verlassen der Einstellungen weiter; Mail erkennt den Anbieterzustand neu, bevor das Ergebnis bestätigt wird. Das Aktionsmenü bietet **In Mail anzeigen** oder **Aus Mail ausblenden**. Daneben steht **Sichtbar**, **Ausgeblendet**, **Nicht verfügbar** oder **Prüfung erforderlich**, damit Sichtbarkeit nicht versehentlich bei Anbieteraktionen geändert wird.

**Spezielle Ordnerzuordnungen** oberhalb der Hierarchie bestimmen die aktiven auswählbaren Ordner für Gesendet, Entwürfe, Archiv, Papierkorb und Junk. Der Posteingang wird vom Anbieter erkannt. Eine falsche oder fehlende Zuordnung kann die zugehörige Unterhaltungsaktion oder Abbildung gesendeter Nachrichten und Entwürfe verhindern.

Stellt das IMAP-Konto gemeinsame Ordner oder Ordner anderer Personen bereit, kann **Neu erkennen** sie in derselben Hierarchie anzeigen. Sie sind Anbieterzustand des verbundenen Kontos und keine eigenen Cloud-Ressourcen. Cloud teilt keine einzelnen Ordner, ändert keine vorgelagerten ACLs, vereint keine gleichnamigen Ordner verschiedener Konten und verwendet nicht die Zugangsdaten einer anderen Person, wenn diese Verbindung den Zugriff verliert.

Änderungen an Namespace, Subscription oder Berechtigungen beim Anbieter können einen Ordner nicht verfügbar oder mehrdeutig machen. Prüfe **Postfachwerkzeuge > Postfachstatus**, korrigiere bei Bedarf den Anbieterzustand und führe dann **Neu erkennen** aus.

Ein dauerhaft verschwundener, nicht verfügbarer Ordner kann mit **Aus Mail entfernen** aus der Cloud-Ordnerliste entfernt werden. Das löscht nichts beim Anbieter und keine gespiegelten Nachrichten. Taucht der Ordner erneut auf, stellt die nächste Erkennung ihn wieder her.

Agents können Anbieterabonnements mit `cld mail folder subscribe` und `cld mail folder unsubscribe` ändern. Beide Befehle erstellen denselben dauerhaften, beobachtbaren Anbieterauftrag wie die Webanwendung.

## Zugriff konfigurieren {icon="shield-lock"}

- **Lesen** für Lesen, Suche, Kommentare und persönliche Erinnerungen.
- **Schreiben** für Versand, Anbieteraktionen und gemeinsame Arbeitszustände.
- **Admin** für Verbindung, Freigaben, Regeln, Workflows und Lebenszyklus.

Verwende den Cloud-Berechtigungseditor und vergib nur die für die Aufgabe nötige Berechtigung. Die Richtlinie **Wer darf automatische Antworten verwalten?** kann **Schreibberechtigte und Administratoren** einbeziehen oder mit dem sicheren Standard **Nur Administratoren** auf Adminrechte begrenzt bleiben. Identitäten, Referenzmuster und YAML-Workflows bleiben trotzdem Postfach-Administratoren vorbehalten. Zugangsdaten bleiben selbst für Administratoren verborgen. Eine Postfachfreigabe gibt Cloud-Zugriff, aber niemals Anbieterpasswort oder Token weiter.

## Anhänge über öffentliche Links freigeben {icon="link"}

Postfach-Adminrechte sind zum Erstellen, Auflisten und Widerrufen erforderlich. Öffne eine empfangene Nachricht oder einen Entwurf und verwende die Linkaktion am Anhang. Dateien über 100 MiB können nicht geteilt werden. Ein Link kann Passwort, Ablaufzeit und eine maximale Zahl von Download-Sitzungen enthalten. Passwörter beachten Groß- und Kleinschreibung und dürfen Leerzeichen enthalten. Die vollständige URL wird nur direkt nach der Erstellung angezeigt; kopiere sie vor dem Schließen. Mail speichert nur einen Hash des geheimen Tokens und kann dieselbe URL nicht erneut anzeigen.

Unter **Postfachwerkzeuge > Geteilte Links** kannst du alle Links einschließlich älterer aktiver Links seitenweise prüfen und widerrufen. Ein Widerruf löscht den ursprünglichen Anhang nicht. Bereichsanfragen zum Fortsetzen eines bereits erlaubten Downloads verbrauchen keine weiteren Downloads. Widerrufene, abgelaufene, ausgeschöpfte oder ungültige Links und falsche Passwörter schlagen fehl, ohne Anhangsmetadaten offenzulegen.

Die CLI bietet dieselben Aktionen mit `cld mail attachment link create`, `list` und `revoke`. Übergib Passwörter über `--password-file` oder `--password-stdin`; ein sichtbarer Kommandozeilenwert wird nicht akzeptiert.

## Mail-Speicher prüfen {icon="database"}

Cloud-Administrationsrechte sind getrennt von Postfach-Adminrechten. **Administration > Mail** zeigt jedes aktive Postfach mit bereinigten Status-, Synchronisierungs-, Speicher-, Zugriffs- und Aufmerksamkeitsdaten, aber keine Nachrichten- oder Anhangsinhalte.

Unter **Sicherheit** kannst du gemeldete verdächtige Nachrichten prüfen und exakte organisationsweite Schutzregeln pflegen. Das Verhalten für Personen und Hinweise zu sicheren Regeln stehen unter **Verdächtige E-Mails erkennen und melden**.

Mit **Berechtigungen** kannst du ein verwaistes Postfach wieder zugänglich machen oder eine versehentliche Freigabe korrigieren. Das ist eine ausdrückliche protokollierte Zugriffsänderung; Cloud-Administratoren erhalten nicht automatisch Zugriff auf Postfachinhalte. Füge einen neuen Administrator hinzu, bevor du den letzten vorhandenen entfernst.

Die CLI bietet dieselbe Wiederherstellung: `cld mail admin mailbox list` findet auch nicht direkt zugängliche Postfächer, `cld mail admin mailbox get <mailbox>` zeigt einen bereinigten Betriebsdatensatz, `cld mail admin mailbox access list|grant|set|revoke <mailbox>` verwaltet direkte Freigaben für Personen, Gruppen oder Dienstkonten und `cld mail admin storage show|reconcile` liest oder aktualisiert die Speicherbeobachtung.

**Speicher abgleichen** stellt einen Hintergrundauftrag ein. Die Seite und `cld mail admin storage show` zeigen bis zu dessen Abschluss den letzten vollständigen Stand; das Einreihen aktualisiert die Zahlen nicht synchron. Die Werte dienen der Beobachtung, sind keine Speicherquoten und erlauben keinen Zugriff auf Inhalte.

## Signaturen und E-Mail-Design {icon="pencil"}

Unter **Einstellungen > Schreiben** kannst du private oder postfachweite Signaturen und Textbausteine verwalten. Weise die Postfach-Standardsignatur unter **Konten und Identitäten > Absenderidentitäten** zu. Ein persönlicher Standard unter **Schreiben** hat Vorrang.

Markdown-E-Mails erhalten immer das gut lesbare Basisdesign. **E-Mail-Design** ergänzt validierte postfachweite CSS-Anpassungen für das Erscheinungsbild der Organisation, ersetzt aber nicht das sichere Basisdesign. Prüfe das Ergebnis vor der Verwendung in der Vorschau des Editors.

## Automatische Antworten und Referenzen einrichten {icon="settings"}

Öffne **Postfachwerkzeuge > Automatisierungen**:

:::steps
1. **Übersicht** zeigt aktive Automatisierungen und öffnet die genaue Einrichtung.
2. **Automatische Antworten** bietet Abwesenheit, Bestätigung außerhalb der Geschäftszeiten, Referenzbestätigung und eigene Vorlagen. Schreibberechtigte Personen können diesen Bereich verwenden, wenn die Zugriffsrichtlinie es erlaubt.
3. **Eingehende E-Mails** bietet geführte Bedingungen und eine gemischte Folge von Mail- und AI-Schritten.
4. **Aktivität** zeigt postfachbezogene Workflow-Ausführungen und Backfills eingehender Automatisierungen.
5. **Workflows** enthält versionierte YAML-Definitionen, die Konfiguration von Referenznummern und ausdrückliche Aktivierungsaktionen.
:::

Eingehende E-Mails, Aktivität und Workflows erfordern Postfach-Adminrechte. Zeitregeln für automatische Antworten stehen direkt in der geführten Antwort oder in der unveränderlichen YAML-Workflow-Version; es gibt keine getrennte Zeitplanressource.

Eine automatische Antwort besitzt Aktivstatus, verifizierte Automatisierungsidentität, Betreff, Nachricht, Markdown- oder Nur-Text-Format, Wiederholungsintervall pro Absender, Zeitzone, aktive Daten, Wochenzeiten, Ausnahmen und ein Verhalten außerhalb aktiver Zeiten: **Nicht antworten** ignoriert solche Nachrichten, **Zum nächsten aktiven Zeitpunkt antworten** verschiebt die Antwort bis dahin. Prüfe die genaue Antwort vor der Aktivierung in der Vorschau. Das Pausieren des Postfachs stoppt automatische Antworten.

Einrichtung, Zeitfolgen, Referenzmuster und Wiederholungsschutz werden unter [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation) beschrieben.

## Workflows verwalten {icon="route"}

Öffne **Automatisierungen > Workflows** für den YAML-Editor. Das Speichern erzeugt eine neue unveränderliche Version und aktiviert sie nicht automatisch. Prüfe YAML, Validierungsdiagnosen und Effektbudgets, bevor du eine Version ausdrücklich aktivierst. Postfachausführungen stehen getrennt unter **Automatisierungen > Aktivität**.

Verwende für übliche Abwesenheits- und Bestätigungsfälle die eigene Oberfläche für automatische Antworten. Workflows sind für deterministische Bedingungen und Aktionen gedacht, die darüber hinausgehen. Alle Eingaben, Auslöser, Aktionen, Bedingungen, Ausdrücke, Standards und geprüften Beispiele stehen in der [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows).

## Ein Postfach löschen und wiederherstellen {icon="point"}

**Gefahrenzone > In „Kürzlich gelöscht“ verschieben** versetzt das Postfach in einen wiederherstellbaren gelöschten Zustand. E-Mails beim Anbieter und aufbewahrte Cloud-Daten werden nicht endgültig gelöscht.

Gelöschte Postfächer erscheinen für wiederherstellungsberechtigte Administratoren unter **Kürzlich gelöscht** in der Mail-Übersicht. Ein wiederhergestelltes Postfach startet pausiert. Prüfe Verbindung, Ordnererkennung und Status unter **Postfachwerkzeuge > Postfachstatus**, bevor du **Postfach fortsetzen** wählst.
