# API Documentation

| Module | Environment | Docs |
|---|---|---|
| **Core** -- encoding, crypto (hashing, UUID/ULID, encryption, TOTP), password, dates, text, fuzzy, highlight, charts, cache, result, svg, timing, streaming, search-params, file-icons, gradients | Universal | [core.md](./core.md) |
| **Money** -- exact amounts, taxes, reconciliation and allocation | Universal | [money.md](./money.md) |
| **CAMT** -- read bank-independent camt.052.001.08 XML account reports | Universal, optional peers | [camt.md](./camt.md) |
| **E-Invoice** -- generate CII XML and read XML/PDF invoice data | Universal, optional peers | [einvoice.md](./einvoice.md) |
| **Finance** -- DATEV CSV and SEPA XML, exact amounts and local XSD validation | Universal, optional peers | [finance.md](./finance.md) |
| **DATEV XML** -- Belegtransfer packages (XML-Schnittstelle online) with invoices, cash and document images | Universal, optional peers | [datev-xml.md](./datev-xml.md) |
| **QR** -- payload generators (wifi, email, tel, vcard, event) and SVG rendering | Universal (requires `lean-qr`) | [core.md#qr](./core.md#qr) |
| **Browser** -- files, images, cookies, clipboard, notifications, kv-store, theme | Browser (DOM) | [browser.md](./browser.md) |
| **Solid** -- mutation, query, timed, hotkeys, dnd, detail-panel, localstorage, clipboard, click-outside, dropzone, a11y | SolidJS | [solid.md](./solid.md) |
