---
title: Who may do what
navTitle: Who may do what
section: Identity and access
order: 305
description: Five words and three rules explain accounts, permissions, API keys, and applications.
tags: [identity, accounts, authorization, api-keys]
updated: 2026-11-03
---

# Who may do what

Cloud uses five words and three rules to explain access.

## Five words

| Word | Meaning |
| --- | --- |
| **Account** | A person, an agent, or a service account. An agent is an account without a person, created by an administrator. A service account belongs to an object or an app, such as a mailbox, and never has an API key of its own. |
| **Group** | Many accounts together. |
| **Permission** (German: **Recht**) | An account or group, a level, and an object. The levels are **View**, **Edit**, and **Manage** (German: **Ansehen**, **Bearbeiten**, **Verwalten**). |
| **API key** | On an account, another sign-in with exactly that account's permissions. For agents, this also takes the form of a client ID and client secret for OAuth programs. On an object, a key may do exactly one thing on that object and belongs to no account. |
| **Manifest** | The app's declaration (`defineApp`): what it offers and needs from the platform. Deployed means allowed. |

## Three rules

1. Every call runs as one account. The provider checks that account's
   permission on the object and the action's rules.
2. An app has no permissions of its own on objects. With a person, it passes
   that person through. Alone, it uses an agent or an object API key stored
   in a setting.
3. Background work runs as its owner, like crontab, with the owner's current
   permissions.

The administrator is root: able to repair access, but with no automatic access
to content. The exception is outgoing app mail in the administrator's
notification view.

## If you know Unix

| Cloud | Unix analogy |
| --- | --- |
| Account | User or service user |
| Group | Group |
| Permission | chmod or ACL |
| API key | authorized_keys, or a link for one object action |
| Manifest | Package |

## Words outside this model

Scopes on new account keys are no longer a separate concept: the account's
permissions decide what the key may do. “As the app” is not an identity with
object permissions. Runtime keys are platform internals, not another account
or permission model.

The detailed pages describe the supported APIs and existing credential formats:
[Resource authorization](/en/docs/identity/authorization),
[App access](/en/docs/identity/app-access),
[Agents and service accounts](/en/docs/identity/service-accounts),
[Background mandates](/en/docs/identity/background-mandates), and
[OAuth](/en/docs/identity/oauth).
