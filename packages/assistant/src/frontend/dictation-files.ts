import { conversationFileSource } from "@k2b/cloud/ai/solid";
import type { FileSource } from "@k2b/ui";

export const formatDictationTimestamp = (timestamp: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(timestamp));

/** Grouped presentation; reads and downloads retain the original file identity. */
export function assistantConversationFileSource(
  conversationId: string,
  locale: () => string,
  voiceInputs: () => string,
): FileSource & { actualPath(path: string): string } {
  const source = conversationFileSource("/api/ai", conversationId);
  const paths = new Map<string, string>();
  const actualPath = (path: string) => paths.get(path) ?? path;
  return {
    ...source,
    actualPath,
    async list() {
      const files = await source.listFiles();
      paths.clear();
      return files.map((file) => {
        const path = `/${file.dictationRecordedAt ? voiceInputs() : "Chat"}${file.path}`;
        paths.set(path, file.path);
        return {
          path,
          mediaType: file.mediaType,
          size: file.size,
          updatedAt: file.updatedAt,
          ...(file.dictationRecordedAt
            ? { displayName: formatDictationTimestamp(file.dictationRecordedAt, locale()), icon: "ti-microphone" }
            : {}),
        };
      });
    },
    read: (path) => source.read(actualPath(path)),
    downloadHref: (path) => source.downloadHref?.(actualPath(path)) ?? null,
    isReadOnly: () => true,
    write: undefined,
    rename: undefined,
    remove: undefined,
    upload: undefined,
  };
}
