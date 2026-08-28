---
id: mail-security
title: Verdächtige E-Mails erkennen und melden
icon: ti ti-shield-lock
description: Mail-Warnungen einordnen, Phishing melden und den Schutz der Organisation verwalten.
order: 35
---

Mail hält unsichere Signale bewusst im Hintergrund, statt jede ungewöhnliche Nachricht als Gefahr darzustellen. Eine Warnung erscheint nur, wenn Mail aussagekräftige und nachvollziehbare Hinweise erkennt. Externe Links, Newsletter oder eine einzelne kleine Abweichung lösen für sich allein keine Warnung aus.

## Wenn eine Warnung erscheint {icon="shield-exclamation"}

Lies die kurzen Begründungen über der Nachricht, bevor du Links öffnest oder antwortest. Mail kann warnen, wenn mehrere Angaben nicht zusammenpassen, zum Beispiel wenn:

- der sichtbare Linktext auf eine andere Website verweist;
- Antworten an eine andere Domain gehen würden und ein weiterer Warnhinweis vorliegt;
- der geschützte Name einer Organisation von einer unerwarteten Domain verwendet wird; oder
- dein empfangendes E-Mail-System meldet, dass die Absenderprüfung fehlgeschlagen ist.

Mail entfernt aktive Skripte immer aus HTML-E-Mails und blockiert externe Bilder, bis du sie ausdrücklich lädst. Dieser Schutz gilt auch für Nachrichten ohne Phishingwarnung.

Eine Person mit Organisations-Adminrechten kann einen exakten Absender, eine Absenderdomain einschließlich ihrer Subdomains oder eine Link-Domain einschließlich ihrer Subdomains blockieren. Mail kennzeichnet passende Nachrichten dann als blockiert und deaktiviert ihre Links und Anhänge im Lesebereich. Das ist strenger als eine Warnung und gilt nur bei ausdrücklich eingerichteten Organisationsregeln.

Dieser Schutz beschränkt sich bewusst auf den Lesebereich von Mail. Er verschiebt keine Nachrichten beim Anbieter und startet, beendet oder dupliziert keine Automatisierungsläufe. Richte eine Automatisierung für eingehende E-Mails separat ein, wenn Nachrichten zusätzlich verschoben, mit Tags versehen oder von automatischen Antworten ausgeschlossen werden sollen.

## Eine verdächtige Nachricht melden {icon="flag"}

Öffne das Nachrichtenmenü und wähle **Phishing melden**. Mail übermittelt den Personen mit Adminrechten die Absenderadresse, die Nachrichten-ID und die berechneten Warnhinweise. Betreff und Nachrichtentext werden für die Administrationsseite weder hochgeladen noch kopiert.

Eine Meldung ist auch dann hilfreich, wenn Mail keine Warnung anzeigt. Personen mit Adminrechten können Meldungen vergleichen, eine Prüfung beginnen, Phishing bestätigen oder einen Fehlalarm verwerfen. Eine erneute Meldung derselben Nachricht aktualisiert die vorhandene Meldung, statt ein störendes Duplikat anzulegen.

Wenn du unsicher bist, öffne weder Links noch Anhänge. Kontaktiere den vermeintlichen Absender über eine bekannte Telefonnummer, eine gespeicherte Website oder eine neue Nachricht an eine Adresse, der du bereits vertraust.

## Für Cloud-Administratoren {icon="settings"}

Öffne **Administration > Mail > Sicherheit**, um Meldungen zu prüfen und organisationsweite Regeln zu verwalten.

- **Blockieren**-Regeln können eine exakte Absenderadresse, eine Absenderdomain einschließlich ihrer Subdomains oder eine Link-Zieldomain einschließlich ihrer Subdomains betreffen.
- **Vertrauen**-Regeln akzeptieren eine Absenderadresse oder Absenderdomain nur, wenn ein konfigurierter Empfangsserver eine bestandene Absenderprüfung meldet, die zur sichtbaren Absenderdomain passt. Eine bestandene Prüfung für eine andere Domain wird ignoriert. Vertrauen setzt eine ausdrückliche Blockierung niemals außer Kraft.
- **Geschützte Identitäten** verbinden einen exakten sichtbaren Absendernamen, etwa ein Unternehmen oder einen Dienst, mit seinen zulässigen Domains. Eine Abweichung erzeugt eine Warnung; sie löscht oder verschiebt die Nachricht nicht.
- **Vertrauenswürdige Authentifizierungsquellen** enthält die Namen der empfangenden E-Mail-Server, deren Ergebnisse zur Absenderprüfung Mail vertrauen darf. Es handelt sich um Servernamen aus `Authentication-Results`, nicht um Absenderdomains. Lass die Liste leer, bis deine Mail-Administration den richtigen Wert bereitstellt.

Halte Regeln eng und ergänze für andere Personen mit Adminrechten eine kurze Begründung. Prüfe Meldungen, bevor du organisationsweite Blockierungen einrichtest. Mail importiert bewusst keine öffentlichen Reputationslisten und meldet E-Mails nicht automatisch an deinen Anbieter.

Dieselben Abläufe stehen in der CLI über `cld mail message report-phishing` und `cld mail admin security ...` zur Verfügung.
