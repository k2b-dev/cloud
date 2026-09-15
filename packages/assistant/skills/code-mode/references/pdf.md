# Generate PDFs

`pdf.render`, `pdf.attach` and `pdf.facturX` are asynchronous and return a PDF
`Blob`. They use the instance's configured PDF service. `pdf.open` is
the local text reader described in [Documents](documents.md).

## HTML and CSS

```js
const document = await pdf.render({
  html: `<!doctype html><html><head><style>
    body { font-family: sans-serif; }
    h1 { color: #087f70; }
    tr { break-inside: avoid; }
  </style></head><body><h1>Stock report</h1><img src="logo.png"></body></html>`,
  assets: [{ name: "logo.png", data: logoFile }],
  page: { format: "A4", landscape: false, margin: { top: 15, right: 15, bottom: 15, left: 15 } },
  tagged: true,
});
await files.save(document, "stock-report.pdf");
```

`html` is required. `assets` defaults to an empty array and accepts named `Blob`
values for local images, fonts and CSS. Use plain filenames, no directories;
reference the exact filename from HTML or CSS. Duplicate names and the reserved
names `index.html`, `header.html`, `footer.html`, `factur-x.xml` fail.
`headerHtml` and `footerHtml` are optional independent HTML strings with their own
CSS. Page markers such as `<span class="pageNumber"></span>` work in
those templates. Background colors are printed.

`page.format` defaults to `A4`; alternatives are `A3`, `A5`, `Letter`, and `Legal`.
`landscape` defaults to false. Each margin is a nonnegative millimeter number,
defaulting to 15. Use `page` for paper dimensions and margins; avoid conflicting
CSS `@page` rules. `tagged` defaults to true, which requests a tagged PDF but does
not certify accessibility.

Studio styles are not inherited. Scripts, redirects, frames and outbound
resources are blocked. Supply local assets or data URLs; this is not a URL-to-PDF
browser or a JavaScript rendering environment.

## Attach files

```js
const result = await pdf.attach({
  document,
  attachments: [{
    name: "details.xml",
    data: new Blob([xml], { type: "application/xml" }),
    relationship: "Data",
  }],
});
await files.shared.write("reports/with-details.pdf", result);
```

The source PDF and attachments are ordinary `Blob`s. Their origin does not
matter: explicit picker selections, authorized chat inputs, or app storage use
the same API. `relationship` defaults to `Unspecified`; alternatives are
`Source`, `Data`, `Alternative`, and `Supplement`. MIME type comes from the Blob
and defaults to `application/octet-stream` if empty. Provide at least one attachment. Names within the request
must be unique. All asset/attachment names are 1–180 characters, with no slash,
backslash or control characters, and cannot be `.` or `..`. Embedding an XML file alone does not create a compliant invoice.

## Factur-X / ZUGFeRD

```js
const checked = einvoice.validate(invoice);
if (!checked.ok) throw new Error(JSON.stringify(checked.error));
const xml = einvoice.serialize(checked.data, { format: "zugferd-2.5-en16931" });
if (!xml.ok) throw new Error(JSON.stringify(xml.error));
const document = await pdf.facturX({
  html: invoiceHtml,
  xml: xml.data.xml,
  profile: "EN 16931",
});
await files.save(document, "invoice.pdf");
```

`facturX` accepts the same render options plus required `xml` and `profile`.
Profiles: `MINIMUM`, `BASIC WL`, `BASIC`, `EN 16931`, `EXTENDED`. Use `EN 16931`
with the bundled `einvoice.serialize` output; that serializer does not support
the other profiles. The service embeds `factur-x.xml`, sets Factur-X 1.0 invoice
metadata and requests PDF/A-3b. The app must supply matching HTML and XML.
Neither rendering nor parsing certifies XSD, Schematron, tax or invoice validity.

## Cancellation, access and limits

All three methods accept a second `{ signal }` argument, for example the signal
from a `work.run` job. Abort rejects with `AbortError`. Stopping the execution
host also cancels pending PDF requests. Rendering creates no stored file until
code explicitly saves it; do not automatically retry failed calls.

Saved resources need Use access, not Manage. One-off scripts need an accessible,
unrestricted current chat. The server checks access before reading the body.
No service URL, credentials, shell flags or arbitrary conversion route are
exposed to app code. This is an internal conversion, not `http.fetch`; there is
no external API approval prompt.

Configured service input, output and timeout limits apply. HTML, its headers,
footers, assets and invoice XML share the HTML input budget. PDF attachments
and the source PDF share the PDF input budget. All transfers also have a 64 MiB
ceiling; multipart framing has a separate bounded overhead. Shared storage and
chat export budgets remain independent. Errors include `PDF_NOT_CONFIGURED`,
`PDF_LIMIT`, `PDF_TIMEOUT`, `PDF_FAILED`, `INVALID_INPUT`, and `ACCESS_DENIED`.
