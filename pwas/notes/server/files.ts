import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { NotesError } from "./errors";
import { boundedBody } from "./http";
import { limits } from "./limits";

export const fileKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "application/pdf"]);
export type CheckedFile = { key: string; name: string; bytes: Uint8Array; type: string; declaredType: string };
export const readUpload = async (request: Request): Promise<CheckedFile> => {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;")) throw new NotesError("multipart_required");
  const bytes = await boundedBody(request, limits.fileBytes + 16_384);
  let form: FormData;
  try {
    form = await new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new NotesError("invalid_file");
  }
  if (
    form.getAll("key").length !== 1 ||
    form.getAll("file").length !== 1 ||
    [...form.keys()].some((key) => key !== "key" && key !== "file")
  )
    throw new NotesError("invalid_file");
  const key = fileKey.safeParse(form.get("key"));
  const file = form.get("file");
  if (!key.success || !(file instanceof File)) throw new NotesError("invalid_file");
  if (file.size > limits.fileBytes) throw new NotesError("file_too_large", 413);
  const data = new Uint8Array(await file.arrayBuffer());
  let type: string | undefined;
  try {
    type = (await fileTypeFromBuffer(data))?.mime;
  } catch {}
  if (!type || !allowed.has(type)) throw new NotesError("unsupported_type", 415);
  const name =
    Array.from(file.name.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\\/]/gu, ""))
      .slice(0, 255)
      .join("") || "file";
  return { key: key.data, name, bytes: data, type, declaredType: file.type.slice(0, 128) };
};
export const fileDisposition = (file: { name: string; type: string }): string => {
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${file.type.startsWith("image/") ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encoded}`;
};
