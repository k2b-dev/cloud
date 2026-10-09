import { stripImageDataUrlMetadata, stripImageMetadata } from "@k2b/cloud/services/image-metadata";

/** Call for authorized, size-bounded uploads classified as images. */
export const prepareImageUpload = (bytes: Uint8Array): Uint8Array =>
  // Throws ImageMetadataError (HTTP 422) for a malformed JPEG, PNG, or WebP.
  // Hono maps it to 422; custom error handlers must preserve that status.
  stripImageMetadata(bytes);

export const prepareInlineImage = (value: string): string => stripImageDataUrlMetadata(value);
