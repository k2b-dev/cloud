---
title: Dashboard
navTitle: Dashboard
section: Platform
order: 360
description: A personal Cloud start page with app widgets, shortcuts, and saved layout preferences.
tags: [dashboard, widgets, shortcuts, personalization]
updated: 2026-09-07
---

# Dashboard

Dashboard is the personal start page for Cloud. It combines summaries published
by applications with shortcuts chosen by the signed-in user, so recurring work
and important status stay visible in one place.

## Use Dashboard

- Scan the app widgets relevant to the current account.
- Open a widget's source application when a summary needs more detail.
- Hide widgets that are not useful for daily work.
- Add shortcuts to Cloud applications or approved external destinations.
- Arrange widgets and choose the greeting style for the current user.

One slow or unavailable widget does not block the rest of the start page. A
missing widget may be hidden, unavailable at the current access level, or
temporarily unable to load from its owning application.

## Understand the Dashboard model

| Resource or surface | Responsibility |
| --- | --- |
| Widget | Summary published and served by an application |
| Shortcut | Link to a Cloud app or a custom relative, HTTP(S), or mailto target |
| Layout | Personal widget order, zone, and span choices |
| Visibility | Personal list of widgets hidden from the start page |
| Greeting style | Personal color preference used by the dashboard header |

Dashboard settings belong to a user-backed session. They are stored per user
and reused after login on another device.

## How Dashboard fits Cloud

Dashboard owns the start-page layout, shortcuts, and personal presentation
settings. Each application owns the data, permissions, destination, and
failure behavior of its widgets. Cloud supplies identity, application
discovery, and the shared widget contract.

Dashboard is a summary surface, not a second editor for application data. Open
the owning application to change the underlying resource or diagnose a failed
card.

## Find detailed product help

Open **Help** inside Dashboard for customization, missing widgets, unavailable
shortcuts, and settings that appear out of date. Developers can read
[Dashboard widgets](/en/docs/platform/dashboard-widgets) and
[Resource authorization](/en/docs/identity/authorization) for the contracts
applications use to contribute safe summaries.

## Use Dashboard from the terminal

Dashboard does not register a dedicated `cld dashboard` module. Its primary
surface is the signed-in web start page, and its personal layout is managed
there. Run `cld help` to inspect the current CLI modules instead of depending
on undocumented dashboard API calls.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
