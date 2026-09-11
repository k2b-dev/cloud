/**
 * FileSource adapter over a conversation's VFS routes (/conversations/:id/files).
 * Files share one flat conversation namespace. Origin metadata preserves who
 * created a file without encoding policy in its path. Browser-safe module.
 */
import type { FileSource, FileTreeEntry, FileViewContent } from "@k2b/ui";
import type { AiFileStat } from "../files-store";

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/xml",
  "image/svg+xml",
  "text/javascript",
  "text/typescript",
]);
const isTextMediaType = (mediaType: string): boolean => mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
};

export const conversationFileSource = (baseUrl: string, conversationId: string): FileSource & { listFiles(): Promise<AiFileStat[]> } => {
  const filesUrl = (suffix = "", params?: Record<string, string>) => {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    return `${baseUrl}/conversations/${conversationId}/files${suffix}${query}`;
  };

  const request = async <T>(url: string, init: RequestInit, fallback: string): Promise<T> => {
    const response = await fetch(url, {
      ...init,
      headers: init.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(await readError(response, fallback));
    return (await response.json()) as T;
  };

  const listFiles = async (): Promise<AiFileStat[]> =>
    (await request<{ files: AiFileStat[] }>(filesUrl(), { method: "GET" }, "Failed to load files")).files;

  return {
    listFiles,
    async list(): Promise<FileTreeEntry[]> {
      return (await listFiles()).map((file) => ({
        path: file.path,
        size: file.size,
        mediaType: file.mediaType,
        updatedAt: file.updatedAt,
        badge: file.dictationRecordedAt ? undefined : file.origin === "user" ? "upload" : undefined,
      }));
    },

    async read(path: string): Promise<FileViewContent> {
      const response = await fetch(filesUrl("/content", { path }));
      if (!response.ok) throw new Error(await readError(response, "Failed to load file"));
      const mediaType = response.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/octet-stream";
      const bytes = new Uint8Array(await response.arrayBuffer());
      return isTextMediaType(mediaType)
        ? { encoding: "utf8", content: new TextDecoder().decode(bytes), mediaType }
        : { encoding: "base64", content: bytesToBase64(bytes), mediaType };
    },

    async write(path, content, encoding = "utf8") {
      await request(filesUrl("/content"), { method: "PUT", body: JSON.stringify({ path, content, encoding }) }, "Failed to save file");
    },

    async remove(path) {
      await request(filesUrl("", { path }), { method: "DELETE" }, "Failed to delete file");
    },

    async rename(from, to) {
      await request(filesUrl("/rename"), { method: "POST", body: JSON.stringify({ from, to }) }, "Failed to rename file");
    },

    async upload(_dirPath, files) {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(filesUrl(), { method: "POST", body: form });
        if (!response.ok) throw new Error(await readError(response, `Failed to upload ${file.name}`));
      }
    },

    downloadHref: (path) => filesUrl("/content", { path }),

    isReadOnly: () => false,
  };
};
