# Generate PDFs

`cloud.pdf.render` and `cloud.pdf.attach` are asynchronous and return a PDF
`Blob`. They use the instance's configured PDF service. `cloud.pdf.read` is
the local text reader described in [Documents](documents.md).

## Choose the path

A document written in the chat needs no code. Use the chat tool
`markdown_to_pdf` for text-first documents; it applies A4 presets and custom CSS
and turns images into links. Use `html_to_pdf` for a chat `.html` file whose
layout needs HTML and CSS, images, or fonts. It takes optional CSS (file or
inline), header and footer files, chat files as named assets, and the `page`
options below, then writes a sibling `.pdf` for `present`. Use `cloud.pdf.render` when
code builds the document from data, for Factur-X or attachments, and in Studio
Apps.

## HTML and CSS

```js
const document = await cloud.pdf.render({
  html: `<!doctype html><html><head><title>Stock report</title><style>
    body { font-family: sans-serif; }
    h1 { color: #087f70; }
    tr { break-inside: avoid; }
  </style></head><body><h1>Stock report</h1><img src="logo.png"></body></html>`,
  assets: [{ name: "logo.png", data: logoFile }],
  page: { format: "A4", landscape: false, margin: { top: 15, right: 15, bottom: 15, left: 15 } },
  tagged: true,
});
await cloud.download("stock-report.pdf", document);
```

`html` is required. Set `title` or include a `<title>`: PDF viewers show it as the document
name, and without one they show a random file name. `assets` defaults to an empty array and accepts named `Blob`
values for local images, fonts and CSS. Use plain filenames, no directories;
reference the exact filename from HTML or CSS. Duplicate names and the reserved
names `index.html`, `header.html`, `footer.html`, `factur-x.xml` fail.
`headerHtml` and `footerHtml` are optional independent HTML strings with their own
CSS. They load no assets; use `data:` URLs for images there. Page markers such as
`<span class="pageNumber"></span>` work in those templates, and the page margin
must leave room for them. Background colors are printed.

`page.format` defaults to `A4`; alternatives are `A3`, `A5`, `Letter`, and `Legal`.
`landscape` defaults to false. Each margin is a nonnegative millimeter number,
defaulting to 15. Use `page` for paper dimensions and margins; avoid conflicting
CSS `@page` rules. `tagged` defaults to true, which requests a tagged PDF but does
not certify accessibility.

In Studio Apps the document gets the base stylesheet of [HTML apps](apps.md)
first, so a custom flex or grid row, such as two signature columns, needs
`> * { margin: 0 }`. `code_check` lays out the HTML of every PDF the steps create
as it prints, with print media, and warns when siblings of one row sit at
different heights.

Charts render in Cloud light colors through a shared chart stylesheet. Your HTML may include `<style>`; header and footer are separate documents with their own CSS. Scripts, redirects, frames and outbound
resources are blocked. MathML (`math`) and the SVG elements `foreignObject` and
`desc` are removed; write formulas and labels as HTML and CSS or as SVG text.
Supply local assets or data URLs; this is not a URL-to-PDF browser or a
JavaScript rendering environment.

## Attach files

```js
const result = await cloud.pdf.attach({
  document,
  attachments: [{
    name: "details.xml",
    data: new Blob([xml], { type: "application/xml" }),
    relationship: "Data",
  }],
});
await cloud.files.write("reports/with-details.pdf", result);
```

The source PDF and attachments are ordinary `Blob`s. Their origin does not
matter: files a person selects in an app, authorized chat inputs, or app storage use
the same API. `relationship` defaults to `Unspecified`; alternatives are
`Source`, `Data`, `Alternative`, and `Supplement`. MIME type comes from the Blob
and defaults to `application/octet-stream` if empty. Provide at least one attachment. Names within the request
must be unique. All asset/attachment names are 1–180 characters, with no slash,
backslash or control characters, and cannot be `.` or `..`. Embedding an XML file alone does not create a compliant invoice.

## Factur-X / ZUGFeRD

```js
const checked = await cloud.finance.einvoice.validate(invoice);
if (!checked.ok) throw new Error(JSON.stringify(checked.error));
const xml = await cloud.finance.einvoice.serialize(checked.data, { format: "zugferd-2.5-en16931" });
if (!xml.ok) throw new Error(JSON.stringify(xml.error));
const document = await cloud.pdf.render({
  html: invoiceHtml,
  facturX: {xml: xml.data.xml, profile: "EN 16931"},
});
await cloud.download("invoice.pdf", document);
```

The `facturX` render option accepts `xml` and an optional `profile` (default EN 16931).
Profiles: `MINIMUM`, `BASIC WL`, `BASIC`, `EN 16931`, `EXTENDED`. Use `EN 16931`
with the bundled `cloud.finance.einvoice.serialize` output; that serializer does not support
the other profiles. The service embeds `factur-x.xml`, sets Factur-X 1.0 invoice
metadata and requests PDF/A-3b. The app must supply matching HTML and XML.
Neither rendering nor parsing certifies XSD, Schematron, tax or invoice validity.

## Save a PDF in Files

A chat PDF stays in the chat until code writes it elsewhere. To save it in the
user's Files, pass its chat path in `code_run.inputPaths` and write it through
the discovered `filesv2.content.create` action:

```js
export default async (_input, {files}) => {
  const document = await files[0].file();
  const target = await cloud.capabilities.run("filesv2.content.create", {
    baseId: "<exact ID from filesv2.bases.list>",
    path: "Offers/offer.pdf",
    size: document.size,
    mediaType: "application/pdf",
  });
  return cloud.capabilities.streams.write(target.stream, document);
};
```

Ask for the storage base and folder when the request does not name them. The user
reviews the write. It creates a new file and fails when the path exists;
replacing requires the current `expectedRevision`. A `cloud.pdf.render` result can be
written the same way without saving it to the chat first. See
[Capability calls](capabilities.md) for stream limits and interrupted writes.

## Cancellation, access and limits

Render and attach accept a second `{ signal }` argument, for example the signal
from the script context. Abort rejects with `CloudError` code `cancelled`. Stopping the execution
host also cancels pending PDF requests. Rendering creates no stored file until
code explicitly saves it; do not automatically retry failed calls.

Saved resources need Use access, not Manage. One-off scripts need an accessible,
unrestricted current chat. The server checks access before reading the body.
No service URL, credentials, shell flags or arbitrary conversion route are
exposed to app code. This is an internal conversion, not `cloud.http.fetch`; there is
no external API approval prompt.

Configured service input, output and timeout limits apply. HTML, its headers,
footers, assets and invoice XML share the HTML input budget. PDF attachments
and the source PDF share the PDF input budget. All transfers also have a 64 MiB
ceiling; multipart framing has a separate bounded overhead. Shared storage and
chat export budgets remain independent. Runtime failures use `CloudError` codes such as `unavailable`, `limit`,
`invalid`, `denied`, and `cancelled`.
