---
title: Image upload privacy
navTitle: Image upload privacy
section: Platform services
order: 346
description: Remove camera and location metadata from images embedded in application content without changing image quality.
tags: [images, uploads, privacy, attachments]
updated: 2026-10-08
---

# Image upload privacy

New JPEG, PNG, and WebP images uploaded to Notebooks attachments, Spaces task
attachments, Grids record files and Form title images, Assistant conversation,
Project and App files, Venue logos, banners, and menu images, profile avatars,
and inline image settings such as the installation logo and model profile logos
lose location and device metadata before storage. This includes GPS, camera
make and model, serial numbers, XMP, IPTC, comments, maker notes, and embedded
thumbnails. Image quality stays the same: the compressed image data is copied without decoding or re-encoding.
JPEG orientation and colour profiles remain, as do transparency and supported
PNG/WebP animation data. Data after the image container is removed.

Files keeps uploaded originals. Mail draft attachments retain their original
bytes for outgoing mail; incoming messages are also unchanged. Contacts and Mail internal notes have no image upload path.

HEIC, AVIF, TIFF, SVG, video, GIF, BMP, and unrecognized formats are stored
unchanged. HEIC, AVIF, TIFF, SVG, and video can retain location or other private
metadata. GIF and BMP are also left unchanged: they do not normally carry EXIF
GPS, but this is **not** a guarantee that they contain no metadata. Remove
private metadata yourself before uploading these formats when needed.

Images that the Assistant writes to conversation, Project, or App files, such
as fetched web images and tool output, pass through the same filter.

Existing images are not rewritten in bulk. An inline image that is submitted
again with a larger value, such as the model profile list, a Form
configuration, or a Venue section, is sanitized on that save. See the
[operations note](/en/docs/operations/image-upload-privacy).

## Use the helper in an application

Call the synchronous `stripImageMetadata(bytes)` from your upload service
before persistence. Apply your existing authorization, upload size limits,
and image classification first. Keep that call in the service so API, CLI,
capabilities, imports, and agents use the same rule.

```ts
import { stripImageMetadata } from "@k2b/cloud/services/image-metadata";

/** Call for authorized, size-bounded uploads classified as images. */
export const prepareImageUpload = (bytes: Uint8Array): Uint8Array =>
  // Throws ImageMetadataError (HTTP 422) for a malformed JPEG, PNG, or WebP.
  // Hono maps it to 422; custom error handlers must preserve that status.
  stripImageMetadata(bytes);
```

`stripImageDataUrlMetadata(value)` applies the same rule to inline `data:`
URLs in any letter case, with or without media type parameters, and with
base64 or percent-encoded content. It selects the format from the decoded
bytes, not from the declared type. A JPEG, PNG, or WebP comes back as
`data:<declared type>;base64,` with canonical base64 and without parameters.
Other content and external URLs return the original string unchanged. Invalid
base64 raises the same typed 422 error. Use it for inline image configuration
before storing the value.

The helper selects JPEG, PNG, or WebP from magic bytes, regardless of MIME type
or filename. Other formats return the same input object. Applications still
own classification: Notebooks and Grids use their image file category, which
includes the filename extension when the declared MIME type is generic; Spaces
uses its supported inline image MIME types; and Assistant uses the media type
or the path extension. An `IMG_0001.jpg` uploaded as `application/octet-stream`
is therefore stripped, while a JPEG uploaded as `scan.bin` with a generic type
stays unchanged. A JPEG classified as an image is stripped even if its declared
image type is PNG. Files never calls this helper for original file storage.

Store the returned bytes and derive size, version, and content hashes from
them. The helper does not store data, change MIME types, fetch URLs, or decode
pixels. It copies the kept bytes into one output buffer that is at most
36 bytes larger than the input, so time and memory grow linearly with the
input length. The work runs synchronously; the application must bound input
size using its upload budget.

## Validation and rendering metadata

Malformed recognized containers throw `ImageMetadataError`, an
`HTTPException` with status `422` and code `MALFORMED_IMAGE`. This includes
truncated segments or chunks, invalid lengths, an invalid EXIF TIFF header or
IFD0 entry table, an Orientation tag that is not a single SHORT, and repeated
or conflicting Orientation tags. Orientation values outside `1..8`, such as
`0` for unknown, count as no orientation. Other EXIF tags, the next-IFD
pointer, JFIF thumbnail data, and fill bytes between JPEG segments are dropped
without further validation. For JPEG orientation `2..8`, the helper writes a
minimal EXIF block containing only that tag. Orientation `1` needs no EXIF
block.

The error message is English API text. Applications show their own localized
message for the stable code `MALFORMED_IMAGE`; Notebooks, Spaces, Grids,
Venue, and Assistant conversation and Project uploads return one in the
request locale.

The allow-list retains JPEG JFIF headers without thumbnails, ICC profile
chunks, Adobe colour information, and codec segments through EOI, including
progressive scans. PNG retains IHDR, PLTE, IDAT, IEND, colour chunks (cHRM,
gAMA, iCCP, sBIT, sRGB, cICP, mDCV, cLLI), display chunks (tRNS, bKGD, pHYs),
and APNG chunks (acTL, fcTL, fdAT). WebP retains VP8/VP8L, VP8X, ALPH, ICCP,
ANIM, and ANMF, clears EXIF/XMP flags, and updates container sizes. Other
segments and chunks are removed. PNG CRCs and compressed codec correctness
are not validated; container validation is not a complete image decoder.

PNG and WebP EXIF is removed entirely, including any orientation tag there.
JPEG is the format whose EXIF orientation is preserved.
