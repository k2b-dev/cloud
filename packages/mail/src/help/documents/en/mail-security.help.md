---
id: mail-security
title: Recognize and report suspicious mail
icon: ti ti-shield-lock
description: Understand Mail warnings, report phishing, and manage organization protection.
order: 35
---

Mail keeps uncertain signals quiet instead of turning every unusual message into an alarm. A warning appears only when Mail has meaningful, explainable evidence. Ordinary external links, newsletters, and a single minor difference do not create a warning by themselves.

## When a warning appears {icon="shield-exclamation"}

Read the short reasons shown above the message before opening links or replying. Mail may warn when several details do not fit together, for example when:

- the visible link text points to a different website;
- replies go to another domain and another warning sign is present;
- a protected organization name arrives from an unexpected domain; or
- your receiving mail system reports that sender verification failed.

Mail always removes active scripts from HTML mail and blocks remote images until you choose to load them. These protections also apply to messages without a phishing warning.

An organization administrator can block an exact sender, a sender domain and its subdomains, or a link domain and its subdomains. Mail then marks matching messages as blocked and disables their links and attachments in the reader. This is stronger than a warning and is used only for explicit organization rules.

This protection is deliberately limited to the Mail reader. It does not move messages at the provider or start, cancel, or duplicate automation runs. Configure an incoming automation separately when messages must also be moved, tagged, or excluded from an automatic reply.

## Report a suspicious message {icon="flag"}

Open the message menu and choose **Report phishing**. Mail sends administrators the sender address, message ID, and the warning evidence it calculated. The report does not upload or copy the subject or message body into the administration page.

Reporting is useful even when Mail shows no warning. Administrators can compare reports, start a review, confirm phishing, or dismiss a false alarm. Reporting the same message again updates the existing report instead of creating a noisy duplicate.

If you are unsure, do not follow links or open attachments. Contact the supposed sender through a known phone number, bookmarked website, or a new message to an address you already trust.

## For Cloud administrators {icon="settings"}

Open **Administration > Mail > Security** to review reports and manage organization-wide rules.

- **Block** rules may target one exact sender address, or a sender or link destination domain including its subdomains.
- **Trust** rules accept one sender address or sender domain only when a configured receiving server reports a passed authentication check aligned with the visible sender domain. A pass for an unrelated domain is ignored, and trust never overrides an explicit block.
- **Protected identities** connect an exact visible sender name, such as a company or service, to its allowed domains. A mismatch creates a warning; it does not delete or move the message.
- **Trusted authentication sources** lists the receiving mail servers whose sender-verification results Mail may trust. These are server names from `Authentication-Results`, not sender domains. Leave this empty until your mail administrator supplies the correct value.

Keep rules narrow and include a short reason for other administrators. Review reports before adding organization-wide blocks. Mail deliberately does not import public reputation lists or automatically report mail to your provider.

The CLI exposes the same workflows through `cld mail message report-phishing` and `cld mail admin security ...`.
