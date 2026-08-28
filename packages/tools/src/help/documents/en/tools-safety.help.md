---
id: tools-safety
title: Data & safety
icon: ti ti-shield-check
description: Understand browser-local processing, server requests, copied secrets, and repeatable checks.
order: 120
---

## Know where the work happens {icon="route"}

- Generators, encoders, color conversion, hashing, passwords, encryption, and image processing are intended for direct interactive use in the page.
- Document to Markdown sends one selected document to this Cloud server for bounded in-memory conversion. The utility does not persist the upload or result.
- Internet Speed Test exchanges data with the Cloud server to measure the connection.
- Webhook Tester creates server-side endpoints and stores request history so incoming calls can be inspected later.

## Handle sensitive values {icon="point"}

- Do not paste production secrets into examples or screenshots.
- Copy generated passwords or encryption material directly into the intended password manager or destination, then clear the page.
- A hash is not encryption and cannot be reversed to recover the original input.
- Keep the key, nonce, and algorithm details required by an encryption result; encrypted text alone may not be enough to decrypt it later.
- Treat webhook URLs as active endpoints until you remove or stop using them.

:::warning Webhook logs
The tester redacts common sensitive headers such as Authorization and Cookie, but request paths and bodies can still contain private data. Use synthetic payloads whenever possible.
:::
