import { storage } from "@k2b/cloud/services";

/** Call from an authorized application service after app.start(). */
export const storeDocumentAndImage = async (pdfBytes: Uint8Array, imageBytes: Uint8Array) => {
  const document = storage.file("orders/42/invoice.pdf");
  await document.write(pdfBytes, { type: "application/pdf" });
  const metadata = await document.stat();
  const size = await document.size;
  const copyBytes = await document.copy("orders/42/invoice-copy.pdf");
  const image = storage.public.file("products/42/photo-v1.webp");
  await image.write(imageBytes, { type: "image/webp" });
  return { metadata, size, copyBytes, permanentImageUrl: await image.url };
};
