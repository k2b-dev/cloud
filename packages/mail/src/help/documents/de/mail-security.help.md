---
id: mail-security
title: Verdächtige E-Mails erkennen und melden
icon: ti ti-shield-lock
description: Mail-Warnungen einordnen, Phishing melden und den Schutz der Organisation verwalten.
order: 35
---

Mail hält unsichere Signale bewusst ruhig, statt jede ungewöhnliche Nachricht als Gefahr zu zeigen. Eine Warnung erscheint nur, wenn Mail aussagekräftige Hinweise hat, die es erklären kann. Normale externe Links, Newsletter oder eine einzelne kleine Abweichung lösen allein keine Warnung aus.

## Eine Warnung prüfen {icon="shield-exclamation"}

Lies die kurzen Begründungen über der Nachricht, bevor du Links öffnest oder antwortest. Mail kann warnen, wenn mehrere Angaben nicht zusammenpassen, zum Beispiel wenn:

- der sichtbare Linktext auf eine andere Website verweist;
- Antworten an eine andere Domain gehen und ein weiterer Warnhinweis vorliegt;
- der geschützte Name einer Organisation von einer unerwarteten Domain kommt; oder
- dein empfangendes E-Mail-System meldet, dass die Absenderprüfung fehlgeschlagen ist.

Mail entfernt aktive Skripte immer aus HTML-E-Mails. Externe Bilder blockiert Mail, bis du sie lädst. Dieser Schutz gilt auch für Nachrichten ohne Phishingwarnung.

Die Cloud-Administration kann einen exakten Absender, eine Absenderdomain mit ihren Subdomains oder eine Link-Domain mit ihren Subdomains blockieren. Mail kennzeichnet passende Nachrichten dann als blockiert und schaltet ihre Links und Anhänge im Lesebereich ab. Das ist strenger als eine Warnung, und Mail nutzt es nur für ausdrückliche Regeln der Organisation.

Dieser Schutz beschränkt sich bewusst auf den Lesebereich von Mail. Er verschiebt keine Nachrichten beim Anbieter und startet, beendet oder dupliziert keine Automatisierungsläufe. Sollen Nachrichten zusätzlich verschoben, mit Tags versehen oder von automatischen Antworten ausgeschlossen werden, richte separat eine Automatisierung für eingehende E-Mails ein.

## Eine verdächtige Nachricht melden {icon="flag"}

Öffne das Nachrichtenmenü und wähle **Phishing melden**. Mail sendet der Administration die Absenderadresse, die Nachrichten-ID und die Warnhinweise, die Mail berechnet hat. Die Meldung lädt Betreff und Nachrichtentext nicht hoch und kopiert sie nicht in die Administrationsseite.

Eine Meldung hilft auch, wenn Mail keine Warnung zeigt. Die Administration kann Meldungen vergleichen, eine Prüfung beginnen, Phishing bestätigen oder einen Fehlalarm verwerfen. Meldest du dieselbe Nachricht erneut, aktualisiert Mail die vorhandene Meldung und legt kein weiteres Duplikat an.

Wenn du unsicher bist, öffne weder Links noch Anhänge. Kontaktiere den vermeintlichen Absender über eine bekannte Telefonnummer, eine gespeicherte Website oder eine neue Nachricht an eine Adresse, der du schon vertraust.

## Regeln der Organisation als Administration festlegen {icon="settings"}

Als Cloud-Administration öffnest du **Administration → Mail → Sicherheit**, um Meldungen zu prüfen und organisationsweite Regeln zu ändern.

- **Blockieren**-Regeln können eine exakte Absenderadresse betreffen, oder eine Absender- oder Link-Domain einschließlich ihrer Subdomains.
- **Vertrauen**-Regeln akzeptieren eine Absenderadresse oder Absenderdomain nur, wenn ein eingerichteter Empfangsserver eine bestandene Absenderprüfung meldet, die zur sichtbaren Absenderdomain passt. Eine bestandene Prüfung für eine andere Domain wird ignoriert. Vertrauen setzt eine ausdrückliche Blockierung nie außer Kraft.
- **Geschützte Identitäten** verbinden einen exakten sichtbaren Absendernamen, etwa ein Unternehmen oder einen Dienst, mit seinen erlaubten Domains. Eine Abweichung erzeugt eine Warnung. Sie löscht oder verschiebt die Nachricht nicht.
- **Vertrauenswürdige Authentifizierungsergebnisse** enthält die empfangenden E-Mail-Server, deren Ergebnisse der Absenderprüfung Mail vertrauen kann. Das sind Servernamen aus `Authentication-Results`, keine Absenderdomains. Lass die Liste leer, bis deine Mail-Administration dir den richtigen Wert gibt.

Halte Regeln eng und ergänze eine kurze Begründung für andere in der Administration. Prüfe Meldungen, bevor du organisationsweite Blockierungen anlegst. Mail importiert keine öffentlichen Reputationslisten und meldet E-Mails nicht automatisch an deinen Anbieter.

Die CLI bietet dieselben Abläufe über `cld mail message report-phishing` und `cld mail admin security ...`.
