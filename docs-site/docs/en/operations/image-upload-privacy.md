---
title: Image upload privacy operations
navTitle: Image upload privacy
section: Operations
order: 1550
description: Understand the scope of metadata removal for newly uploaded content images.
tags: [operations, images, uploads, privacy]
updated: 2026-10-08
---

# Image upload privacy operations

Metadata removal applies to new uploads and replacements through the content
image services listed in [Image upload privacy](/en/docs/platform/image-upload-privacy).
There is no configuration switch or background rewrite.

Images uploaded before this change keep their existing bytes, metadata,
size, and hashes. Retained revisions, backups, exports, and copies of existing
files can still contain the original metadata. Replacing an image sanitizes
the replacement; it does not erase retained older versions.

Inline images stored inside a larger value are sanitized when that value is
saved again: saving the model profile list processes every profile logo, and
saving a Form configuration, Venue settings, or a Venue section processes
its images. If such a stored image is a malformed JPEG, PNG, or WebP, the save
answers HTTP 422 until the image is replaced. Images that the Assistant
fetches or writes are processed the same way, so a malformed fetched image is
not stored.

Files originals and Mail draft attachments remain unchanged. HEIC, AVIF,
TIFF, SVG, GIF, BMP, video, and unrecognized formats also remain unchanged.
This change does not guarantee that every stored image is free of location
metadata. For an existing sensitive image, follow the application's retention
and deletion rules before deciding how to remove all retained copies.
