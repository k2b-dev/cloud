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
Project and App files, profile avatars, and inline image settings such as
the installation logo and model profile logos lose location and device metadata
before storage. This includes GPS, camera make and model, serial numbers, XMP,
IPTC, comments, maker notes, and embedded thumbnails. Image quality stays the
same: the compressed image data is copied without decoding or re-encoding.
JPEG orientation and colour profiles remain, as do transparency and supported
PNG/WebP animation data. Data after the image container is removed.

Files keeps uploaded originals. Mail draft attachments retain their original
bytes for outgoing mail; incoming messages are also unchanged. Contacts and Mail internal notes have no image upload path.

HEIC, AVIF, TIFF, SVG, video, GIF, BMP, and unrecognized formats are stored
unchanged. HEIC, AVIF, TIFF, SVG, and video can retain location or other private
metadata. GIF and BMP are also left unchanged: they do not normally carry EXIF
GPS, but this is **not** a guarantee that they contain no metadata. Remove
private metadata yourself before uploading these formats when needed.

Existing images are not rewritten. See the
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

`stripImageDataUrlMetadata(value)` applies the same rule to base64 image data
URLs. External URLs remain unchanged; invalid base64 raises the same typed
422 error. Use it for inline image configuration before storing the value.

The helper selects JPEG, PNG, or WebP from magic bytes, regardless of MIME type
or filename. Other formats return the same input object. Applications still
own classification: Notebooks uses its image category (including filename
fallback), Spaces its supported inline image MIME types, and Grids and
Assistant their stored image MIME type. A JPEG classified as a generic file
stays unchanged; a JPEG classified as an image is stripped even if its declared
image type is PNG. Files never calls this helper for original file storage.

Store the returned bytes and derive size and content hashes from them. The
helper does not store data, change MIME types, fetch URLs, or decode pixels.
Its time and memory use are linear in the input length; the application must
bound input size using its upload budget.

## Validation and rendering metadata

Malformed recognized containers throw `ImageMetadataError`, an
`HTTPException` with status `422` and code `MALFORMED_IMAGE`. This includes
truncated segments or chunks, invalid lengths and EXIF TIFF headers, and
invalid IFD0 offsets or entries. EXIF Orientation must be a single SHORT in
`1..8`; other values are rejected. For JPEG orientation `2..8`, the helper
writes a minimal EXIF block containing only that tag. Orientation `1` needs
no EXIF block.

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
