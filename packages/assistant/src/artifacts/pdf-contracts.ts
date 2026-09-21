import { z } from "zod";
import { STORAGE_FILE_MAX_BYTES } from "./storage-contracts";

const Name = z
  .string()
  .min(1)
  .max(180)
  .refine((name) => !/[\\/\x00-\x1f]/.test(name) && name !== "." && name !== "..", "Use a plain filename without directories");
const Data = z.instanceof(Blob);
const Asset = z.object({ name: Name, data: Data }).strict();
const Margin = z.number().finite().nonnegative();
export const PdfHtml = z
  .object({
    html: z.string().min(1),
    assets: z.array(Asset).default([]),
    headerHtml: z.string().optional(),
    footerHtml: z.string().optional(),
    page: z
      .object({
        format: z.enum(["A4", "A3", "A5", "Letter", "Legal"]).default("A4"),
        landscape: z.boolean().default(false),
        margin: z
          .object({ top: Margin.optional(), right: Margin.optional(), bottom: Margin.optional(), left: Margin.optional() })
          .strict()
          .optional(),
      })
      .strict()
      .default({ format: "A4", landscape: false }),
    tagged: z.boolean().default(true),
  })
  .strict();
export const PdfAttachment = Asset.extend({
  relationship: z.enum(["Source", "Data", "Alternative", "Supplement", "Unspecified"]).default("Unspecified"),
});
export const PdfRequest = z.discriminatedUnion("operation", [
  PdfHtml.extend({ operation: z.literal("render") }),
  PdfHtml.extend({
    operation: z.literal("facturX"),
    xml: z.string().min(1),
    profile: z.enum(["MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED"]),
  }),
  z.object({ operation: z.literal("attach"), document: Data, attachments: z.array(PdfAttachment).min(1) }).strict(),
]);
export type PdfRequest = z.infer<typeof PdfRequest>;
export type PdfRenderInput = z.input<typeof PdfHtml>;
export type PdfFacturXInput = PdfRenderInput & { xml: string; profile: "MINIMUM" | "BASIC WL" | "BASIC" | "EN 16931" | "EXTENDED" };
export type PdfAttachInput = { document: Blob; attachments: z.input<typeof PdfAttachment>[] };

export function checkPdfBytes(request: PdfRequest) {
  const size =
    request.operation === "attach"
      ? request.document.size + request.attachments.reduce((sum, file) => sum + file.data.size, 0)
      : new Blob([request.html, request.headerHtml ?? "", request.footerHtml ?? "", request.operation === "facturX" ? request.xml : ""])
          .size + request.assets.reduce((sum, file) => sum + file.data.size, 0);
  if (size > STORAGE_FILE_MAX_BYTES) throw new Error("PDF input exceeds the 64 MiB transfer budget");
  return size;
}

/** Binary multipart, with only metadata serialized as JSON. */
export function encodePdfRequest(input: unknown): FormData {
  const request = PdfRequest.parse(input);
  checkPdfBytes(request);
  const form = new FormData();
  if (request.operation === "attach") {
    form.append("document", request.document);
    request.attachments.forEach((file) => form.append("files", file.data, file.name));
    form.append(
      "request",
      JSON.stringify({
        ...request,
        document: undefined,
        attachments: request.attachments.map(({ data, ...metadata }) => ({ ...metadata, type: data.type })),
      }),
    );
  } else {
    request.assets.forEach((file) => form.append("files", file.data, file.name));
    form.append(
      "request",
      JSON.stringify({ ...request, assets: request.assets.map(({ data, ...metadata }) => ({ ...metadata, type: data.type })) }),
    );
  }
  return form;
}

export function decodePdfRequest(form: FormData): PdfRequest {
  const metadata = z
    .object({ operation: z.enum(["render", "facturX", "attach"]) })
    .passthrough()
    .parse(JSON.parse(z.string().parse(form.get("request"))));
  const key = metadata.operation === "attach" ? "attachments" : "assets";
  const files = form.getAll("files");
  const entries = z.array(z.object({ name: Name, type: z.string(), relationship: z.string().optional() }).strict()).parse(metadata[key]);
  if (files.length !== entries.length) throw new Error("PDF file metadata does not match files");
  const values = entries.map(({ type, ...entry }, index) => ({ ...entry, data: Data.parse(files[index]).slice(0, undefined, type) }));
  const request = PdfRequest.parse({
    ...metadata,
    [key]: values,
    ...(metadata.operation === "attach" ? { document: form.get("document") } : {}),
  });
  checkPdfBytes(request);
  return request;
}
