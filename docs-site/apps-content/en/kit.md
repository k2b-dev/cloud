---
title: Kit
navTitle: Kit
section: Everyday
order: 250
description: Create and share browser tools with JavaScript and Markdown pages.
tags: [kit, browser, tools, cli]
updated: 2026-09-09
---

# Kit

Kit lets you create and share small browser tools. Start with a blank app or
the CSV workshop, edit JavaScript and Markdown files, then save and share the
app with other Cloud users.

## Use Kit

- Open an app and choose **Start** to run a tool. Opening an app does not run its scripts.
- Add Markdown pages for instructions beside your tools.
- Process local files and download results without uploading their contents.
- Use **Edit** to change source, preview tools and inspect their console output.
- Manage sharing and inspect the current user's local app data in **Settings**.

Scripts run in an isolated browser worker without Cloud credentials or network
access. Anyone with Use access can read the app's source, so do not put secrets
in code. Cloud stores app source and sharing grants; local files and results
stay in the browser unless the user downloads them.

## Author apps from the terminal

```sh
cld kit init ./csv-tool
cld kit validate ./csv-tool
cld kit push ./csv-tool --json
```

Run `cld kit --help` for authoring and sharing commands. Read
[Kit browser apps](/en/docs/applications/kit) for the SDK, permissions and
revision handling. In-product **Help** covers using, editing and sharing apps.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
startup prerequisites and functional checks.
