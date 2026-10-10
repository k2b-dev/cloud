---
id: mail-security
title: Recognize and report suspicious mail
icon: ti ti-shield-lock
description: Understand Mail warnings, report phishing, and manage organization protection.
order: 35
---

Mail keeps uncertain signals quiet instead of turning every unusual message into an alarm. A warning appears only when Mail has meaningful evidence that it can explain. Ordinary external links, newsletters, and a single minor difference do not create a warning by themselves.

## Check a warning {icon="shield-exclamation"}

Before you open links or reply, read the short reasons above the message. Mail can warn when several details do not fit together, for example when:

- the visible link text points to a different website;
- replies go to another domain and another warning sign is present;
- a protected organization name arrives from an unexpected domain; or
- your receiving mail system reports that sender verification failed.

Mail always removes active scripts from HTML mail. It blocks remote images until you choose to load them. These protections also apply to messages without a phishing warning.

A Cloud administrator can block an exact sender, a sender domain and its subdomains, or a link domain and its subdomains. Mail then marks matching messages as blocked and turns off their links and attachments in the reader. This is stronger than a warning, and Mail uses it only for explicit organization rules.

This protection is limited to the Mail reader on purpose. It does not move messages at the provider or start, cancel, or duplicate automation runs. When messages must also be moved, tagged, or excluded from an automatic reply, set up an incoming automation separately.

## Report a suspicious message {icon="flag"}

Open the message menu and choose **Report phishing**. Mail sends administrators the sender address, the message ID, and the warning evidence that Mail calculated. The report does not upload or copy the subject or message body into the administration page.

A report helps even when Mail shows no warning. Administrators can compare reports, start a review, confirm phishing, or dismiss a false alarm. When you report the same message again, Mail updates the existing report and creates no extra duplicate.

If you are unsure, do not follow links or open attachments. Contact the supposed sender through a phone number that you know, a bookmarked website, or a new message to an address that you already trust.

## Set organization rules as an administrator {icon="settings"}

As a Cloud administrator, open **Admin → Mail → Security** to review reports and change organization-wide rules.

- **Block** rules can target one exact sender address, or a sender domain or link domain including its subdomains.
- **Trust** rules accept one sender address or sender domain only when a configured receiving server reports a passed authentication check that matches the visible sender domain. A pass for an unrelated domain is ignored, and trust never overrides an explicit block.
- **Protected identities** connect an exact visible sender name, such as a company or service, to its allowed domains. A mismatch creates a warning. It does not delete or move the message.
- **Trusted authentication results** lists the receiving mail servers whose sender verification results Mail can trust. These are server names from `Authentication-Results`, not sender domains. Leave the list empty until your mail administrator gives you the correct value.

Keep rules narrow and add a short reason for other administrators. Review reports before you add organization-wide blocks. Mail does not import public reputation lists and does not report mail to your provider automatically.

The CLI offers the same workflows through `cld mail message report-phishing` and `cld mail admin security ...`.
