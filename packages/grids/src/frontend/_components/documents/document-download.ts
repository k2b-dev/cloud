import { errorMessage } from "../utils/api-helpers";
import { documentMessages } from "./messages";

const decodeHeaderValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const filenameFromContentDisposition = (value: string | null): string | null => {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeHeaderValue(encoded);
  const quoted = value.match(/filename="([^"]+)"/i)?.[1];
  return quoted ? quoted.replace(/\\"/g, '"') : null;
};

const filenameFromResponse = (res: Response, fallbackName: string): string => {
  const encodedHeader = res.headers.get("X-Grids-Document-Filename");
  if (encodedHeader) return decodeHeaderValue(encodedHeader);
  return filenameFromContentDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
};

export const downloadPdfResponse = async (res: Response, fallbackName: string, locale = "en") => {
  if (!res.ok) throw new Error(await errorMessage(res, documentMessages.resolve([locale]).t.failedToRenderPdf));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filenameFromResponse(res, fallbackName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
