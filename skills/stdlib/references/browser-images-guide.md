# Image Processing Guide

## Pipeline Pattern

All image transforms return `Promise<ImgData>`, so they can be chained with `.then()` or sequenced with `await`:

```ts
const result = await create(file)
  .then(img => resize(img, 300, 300, "cover"))
  .then(img => filter(img, filters.grayscale))
  .then(img => toBlob(img, "webp", 0.9));
```

**Transforms are immutable** -- each step creates a new canvas. The original `ImgData` is never mutated, so you can branch a pipeline safely:

```ts
const original = await create(file);
const thumbnail = await resize(original, 150, 150, "cover");
const preview = await resize(original, 800);  // original is unchanged
```

End every pipeline with an output function:
- `toBlob(img, format?, quality?)` -- returns a `Blob` for uploading or storing
- `toBase64(img, format?, quality?)` -- returns a data URL string for inline display
- `toFile(img, filename, format?, quality?)` -- returns a `File` for form submission

## Resize Strategies

### `"fill"` -- Stretch to Exact Dimensions
Stretches the image to exactly the specified width and height. **May distort** the image if the target aspect ratio differs from the source.

```ts
await resize(img, 800, 600, "fill");
```

Use for: backgrounds, texture maps, cases where exact pixel dimensions are required.

### `"cover"` -- Crop to Fill
Scales the image so it completely covers the target dimensions, then crops the overflow. **Maintains aspect ratio**, no letterboxing. Some content at the edges will be lost.

```ts
await resize(img, 200, 200, "cover");
```

Use for: avatars, profile pictures, card images -- anywhere you need a fixed frame with no empty space.

### `"contain"` -- Fit Inside Bounds
Scales the image to fit entirely within the target dimensions. **Maintains aspect ratio**, adds letterboxing (transparent or background-colored bars) if the aspect ratios differ.

```ts
await resize(img, 300, 300, "contain");
```

Use for: thumbnails, galleries, product images -- anywhere the full image must be visible.

### Quick Reference

| Scenario       | Strategy    | Why                                      |
|----------------|-------------|------------------------------------------|
| Avatars        | `"cover"`   | Fixed square, no empty space             |
| Thumbnails     | `"contain"` | Show full image within bounds            |
| Backgrounds    | `"fill"`    | Must cover exact viewport dimensions     |
| Gallery cards  | `"cover"`   | Consistent card size, crop edges         |
| Email inline   | `"contain"` | Preserve full content, predictable size  |

## Format Selection

### WebP
- Best compression-to-quality ratio
- 95%+ browser support (all modern browsers)
- Supports both lossy and lossless compression
- Supports transparency
- **Recommended as the default format for web delivery**

### JPEG
- Universal support across all browsers and image viewers
- Good compression for photographs
- No transparency support
- Use when you need maximum compatibility (email, legacy systems)

### PNG
- Lossless compression -- no quality loss
- Full transparency support (alpha channel)
- Large file sizes, especially for photographs
- **Avoid for photos** -- use WebP or JPEG instead
- Use for: screenshots, diagrams, icons, images with text

### Quality Guidelines

```ts
// High quality (large files) -- use for archival or print
await toBlob(img, "webp", 0.95);

// Balanced (recommended default)
await toBlob(img, "webp", 0.85);

// Smaller files (thumbnails, previews)
await toBlob(img, "jpeg", 0.7);
```

## Batch Processing

Use `batch()` with a progress callback to process multiple images. Process sequentially (not in parallel) to avoid memory pressure from holding multiple decoded images in memory simultaneously:

```ts
const files: File[] = [...]; // from input or drop

const results = await batch(files, {
  transform: async (img) => {
    const resized = await resize(img, 300, 300, "cover");
    return toBlob(resized, "webp", 0.85);
  },
  onProgress: (completed, total) => {
    progressBar.value = completed / total;
    statusText.textContent = `${completed} / ${total}`;
  },
});
```

For very large batches, consider chunking to allow the UI to remain responsive:

```ts
const CHUNK_SIZE = 10;
for (let i = 0; i < files.length; i += CHUNK_SIZE) {
  const chunk = files.slice(i, i + CHUNK_SIZE);
  await batch(chunk, { transform, onProgress });
  await new Promise(r => setTimeout(r, 0)); // yield to UI
}
```

## Common Recipes

### Avatar Processing

```ts
const avatar = await create(file)
  .then(img => resize(img, 200, 200, "cover"))
  .then(img => toBase64(img, "webp"));

// avatar is a data URL string, ready for <img src="...">
imgElement.src = avatar;
```

### Thumbnail Grid

```ts
const thumbnails = await batch(files, {
  transform: async (img) => {
    const resized = await resize(img, 300, 300, "contain");
    return toBlob(resized, "jpeg", 0.8);
  },
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

// thumbnails is Blob[] -- create object URLs for display
thumbnails.forEach(blob => {
  const img = document.createElement("img");
  img.src = URL.createObjectURL(blob);
  gallery.appendChild(img);
});
```

### Watermark / Custom Canvas Draw

```ts
const watermarked = await create(file)
  .then(img => apply(img, (ctx, width, height) => {
    ctx.globalAlpha = 0.3;
    ctx.font = "24px sans-serif";
    ctx.fillStyle = "white";
    ctx.fillText("(c) 2026", width - 120, height - 20);
    ctx.globalAlpha = 1.0;
  }))
  .then(img => toFile(img, "watermarked.webp", "webp", 0.9));
```

### Filter Preview

```ts
const filterList = [filters.vintage, filters.grayscale, filters.sepia];

const previews = await Promise.all(
  filterList.map(async (f) => {
    const filtered = await create(file)
      .then(img => filter(img, f))
      .then(img => toBase64(img, "webp", 0.8));
    return filtered;
  }),
);

// previews is string[] of data URLs
previews.forEach((src, i) => {
  previewElements[i].src = src;
});
```
