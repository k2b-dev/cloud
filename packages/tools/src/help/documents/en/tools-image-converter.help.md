---
id: tools-image-converter
title: Convert images
icon: ti ti-arrows-exchange
description: Convert a batch of mixed images to JPEG, PNG, WebP, or Base64 HTML in the browser.
order: 117
---

**Image Converter** turns mixed browser-readable images into one consistent output. It does not upload them.

:::steps
1. Choose **Add images**, or drop files anywhere in the image workspace.
2. If needed, select, remove, or rotate a preview clockwise before export.
:::

The export settings open automatically as soon as the batch contains an image. They close again when the batch is empty.

## Choose the output {icon="photo"}

:::reference
- **JPEG:** A broadly compatible photographic format. Choose its quality and the background color for transparent pixels.
- **PNG:** A lossless format that keeps transparency. It has no quality setting.
- **WebP:** A compact web format with adjustable quality and transparency support.
- **Base64 HTML:** The split menu beside each export action copies complete `<img>` tags. Each tag embeds its image data directly in the `src` attribute.
:::

**Max width** and **Max height** preserve the aspect ratio and never enlarge a smaller image. Leave a field empty when that dimension needs no limit. The limits apply after rotation, so the exported dimensions stay inside the requested bounds.

## Export a batch {icon="package-export"}

To export only part of the batch, select individual previews first. With no selection, the main action exports every image. With an active selection, the separate actions **Export all** and **Export selected** stay available. Each action shows its image count.

A single converted file downloads directly. Multiple files download together as `converted-images.zip`. To copy one Base64 HTML tag per image instead, use the split menu beside either export action. Duplicate source names receive a numeric suffix, so no result overwrites another.

:::info Email signatures
Base64 image tags are useful in controlled HTML. Email editors and recipients do not all support them consistently. Uploaded or hosted signature images are usually more reliable.
:::

## Understand browser processing {icon="shield-check"}

The converter keeps source files and results in the current browser page. It does not upload or persist them. The supported input formats depend on what the browser can decode. The converter rasterizes vector images and turns animated images into still images. The converted output does not keep image metadata.
