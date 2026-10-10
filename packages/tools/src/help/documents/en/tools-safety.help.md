---
id: tools-safety
title: Keep data safe
icon: ti ti-shield-check
description: Know which tools process data in the browser or on the server, and protect copied secrets and webhook data.
order: 120
---

## Know where the work happens {icon="route"}

- Generators, Base64, Hex, Base32, color conversion, hashing, passwords, encryption, and image processing are for direct interactive use in the page.
- **Document to Markdown** sends one selected document to this Cloud server for bounded in-memory conversion. The utility does not persist the upload or the result.
- **Markdown to PDF** sends the Markdown and CSS to this Cloud server, which renders the PDF in memory. The utility does not persist the input or the PDF.
- **Internet Speed Test** exchanges data with the Cloud server to measure the connection.
- **Webhook Tester** creates endpoints on the server and stores the request history, so that you can inspect incoming calls later.

## Protect sensitive values {icon="point"}

:::warning Webhook logs
The tester redacts common sensitive headers such as Authorization and Cookie. Request paths and bodies can still contain private data. Use synthetic payloads whenever possible.
:::

- Do not paste production secrets into examples or screenshots.
- Copy generated passwords or encryption material directly into the intended password manager or destination. Then clear the page.
- A hash is not encryption. You cannot reverse it to recover the original input.
- Keep the key, the nonce, and the algorithm details that an encryption result needs. The encrypted text alone is not always enough to decrypt it later.
- Treat webhook URLs as active endpoints until you remove them or stop using them.
