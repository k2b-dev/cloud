---
id: tools-image-converter
title: Convert images
icon: ti ti-arrows-exchange
description: Convert mixed image batches to JPEG, PNG, WebP, or Base64 HTML.
order: 117
---

Image Converter turns mixed browser-readable images into one consistent output without uploading them. Add files with the picker or drop them anywhere in the image workspace. Each preview can be selected, removed, or rotated clockwise before export.

The export settings open automatically as soon as the batch contains an image and close again when the batch is empty.

## Choose the output {icon="photo"}

:::reference
- **JPEG:** A broadly compatible photographic format. Choose its quality and the background color used for transparent pixels.
- **PNG:** A lossless format that keeps transparency. It has no quality setting.
- **WebP:** A compact web format with adjustable quality and transparency support.
- **Base64 HTML:** The split menu beside each export action copies complete `<img>` tags whose image data is embedded directly in each `src` attribute.
:::

Maximum width and height preserve the aspect ratio and never enlarge a smaller image. Leave either field empty when that dimension does not need a limit. Limits apply after rotation, so the exported dimensions still stay inside the requested bounds.

## Export a batch {icon="package-export"}

Select individual previews when only part of the batch should be exported. With no selection, the main action exports every image. With an active selection, separate **Export all** and **Export selected** actions remain available.

A single converted file downloads directly. Multiple files download together as `converted-images.zip`. Use the split menu beside either export action to copy one Base64 HTML tag per image instead. Duplicate source names receive a numeric suffix so no result overwrites another.

:::info Email signatures
Base64 image tags are useful in controlled HTML, but mail editors and recipients do not all handle them consistently. Uploaded or hosted signature images are usually more reliable.
:::

## Understand browser processing {icon="shield-check"}

The converter keeps source files and results in the current browser page. It does not upload or persist them. Supported input formats depend on what the browser can decode. Vector images are rasterized, animated images become still images, and image metadata is not preserved in the converted output.
