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
| **Account** | A person, an agent, or a service account. An agent is an account without a person, created by an administrator. A service account belongs to an object or an app, such as a mailbox. |
| **Group** | Many accounts together. |
| **Permission** (German: **Recht**) | An account or group, a level, and an object. The levels are **View**, **Edit**, and **Manage** (German: **Ansehen**, **Bearbeiten**, **Verwalten**). |
| **API key** | On an account, another sign-in that may do what that account may do. A new agent key acts exactly as its agent; an older key keeps the narrower scopes it was created with, and a models-only key reaches only AI models. For agents, an OAuth client ID and secret are the other form. On an object, a key may do one thing on that object and acts for no person or agent; Cloud stores it on a resource-bound account of that object. |
| **Manifest** | The app's declaration (`defineApp`): what it offers and needs from the platform. Deploying the app grants its declared platform permissions; a few, such as reading other apps' mail, also need an operator's grant. |

## Three rules

1. Every call on an object runs as one account. The provider checks that
   account's permission on the object and the action's rules.
2. An app has no permissions of its own on objects. With a person, it passes
   that person through. Alone, it uses an agent or an object API key stored
   in a setting. An app may call platform services without a person
   (`appCaller()`), but that reaches no object.
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

Scopes on new agent keys are no longer a separate concept: the agent's
permissions decide what the key may do. Older keys keep their scopes. “As the app” is not an identity with
object permissions. Runtime keys are platform internals, not another account
or permission model.

The detailed pages describe the supported APIs and existing credential formats:
[Resource authorization](/en/docs/identity/authorization),
[App access](/en/docs/identity/app-access),
[Agents and service accounts](/en/docs/identity/service-accounts),
[Background mandates](/en/docs/identity/background-mandates), and
[OAuth](/en/docs/identity/oauth).
