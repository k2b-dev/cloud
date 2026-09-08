---
title: Choose the documentation website
navTitle: Documentation website
section: Accounts & sign-in
order: 1089
description: Point Administration help links at the public documentation or your own mirror.
tags: [accounts, administration, authentication]
updated: 2026-09-09
---

# Choose the documentation website

Administration's **Documentation** links open the relevant article in a new tab.
They do not send account data or unsaved form values.
The documentation is currently English, including links from the German interface.

## Set the base address

Open **Administration → General → Overview** and change **Documentation website**.
The default is `https://cloud.k2b.dev`.

Use a complete HTTP(S) base URL without credentials, query or fragment.
A path prefix is allowed, for example `https://docs.example.org/cloud`.
The mirror must serve the same `/en/docs/…` article paths below that prefix.
Choose **Use default** and save to return to the public website.

This setting changes help links only. It does not host documentation, configure
the authenticator, or change which website may approve sign-ins.
The built-in Help reader remains available independently.

## Use the CLI

```bash
cld admin documentation get --json
cld admin documentation set --url https://docs.example.org/cloud --yes
```

The setting is `app.documentation_url`. Saving it does not change other settings.

## Check your mirror

Publish documentation matching the Cloud version you run. Its address must be
reachable by the people using Administration, not only by the Cloud server.
After saving, reload Administration and open a **Documentation** link. Check
that it opens the relevant article rather than the mirror's home page or an error.

A self-hosted Fibel site also has its own `CLOUD_DOCS_SITE_URL` configuration.
That identifies the documentation website itself; it does not update Cloud's
help-link setting.
