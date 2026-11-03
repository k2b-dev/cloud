import { text } from "@k2b/stdlib";
import type { ChooseFilesOptions } from "./FileChooser";
import { fileChooserMessages } from "./file-chooser-messages";

/**
 * Why files picked or dropped from this device do not fit the caller's limits, in the chooser's words, or
 * `undefined`. The same `maxFiles`, `maxBytes`, and `maxTotalBytes` apply as to files from providers.
 */
export const deviceFilesProblem = (files: readonly File[], options: ChooseFilesOptions, locale: string): string | undefined => {
  const t = fileChooserMessages.resolve([locale]).t;
  const bytes = (value: number) => text.pprintBytes(value, { locale });
  const most = options.multiple ? options.maxFiles : 1;
  if (most !== undefined && files.length > most) return t.tooMany({ count: most });
  const perFile = Math.min(options.maxBytes ?? Number.POSITIVE_INFINITY, options.maxTotalBytes ?? Number.POSITIVE_INFINITY);
  const large = files.find((file) => file.size > perFile);
  if (large) return t.fileTooLarge({ name: large.name, limit: bytes(perFile) });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (options.maxTotalBytes !== undefined && total > options.maxTotalBytes)
    return t.tooLargeTogether({ limit: bytes(options.maxTotalBytes) });
  return undefined;
};
