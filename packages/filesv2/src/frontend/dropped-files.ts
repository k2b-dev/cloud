/** Metadata-only preparation has a fixed browser budget; file bytes are read later by the uploader. */
const MAX_ENTRIES = 10_000;
const paths = new WeakMap<File, string>();
export const uploadRelativePath = (file: File) => paths.get(file) || file.webkitRelativePath || file.name;

function read<T>(signal: AbortSignal, start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    const settle = (value: T) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const fail = (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    };
    try {
      start(settle, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/*
 * WebKit hides every entry whose name starts with a dot: it leaves them out of folder listings and refuses a
 * dropped one with NotFoundError ("Path does not exist"). Such a refusal is a browser limit, not a failure.
 */
const refusedHidden = (entry: FileSystemEntry, error: unknown) =>
  entry.name.startsWith(".") && error instanceof DOMException && error.name === "NotFoundError";

export async function readDroppedEntries(entries: readonly FileSystemEntry[], signal: AbortSignal) {
  signal.throwIfAborted();
  const files: File[] = [];
  const directories: string[] = [];
  const errors: string[] = [];
  const hidden: string[] = [];
  let visited = 0;
  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    signal.throwIfAborted();
    if (++visited > MAX_ENTRIES) throw new Error("drop_too_large");
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      directories.push(path);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (let listed = false; ; listed = true) {
        signal.throwIfAborted();
        let batch: FileSystemEntry[];
        try {
          batch = await read<FileSystemEntry[]>(signal, (resolve, reject) => reader.readEntries(resolve, reject));
        } catch (error) {
          // An unreadable folder, often a system folder on a volume root, costs only its own contents.
          signal.throwIfAborted();
          if (!listed && refusedHidden(entry, error)) {
            // Nothing below it was read yet, so the refused folder is still the last one recorded.
            directories.pop();
            hidden.push(path);
          } else errors.push(`${path}: ${error instanceof Error ? error.message : "read_failed"}`);
          break;
        }
        if (!batch.length) break;
        for (const child of batch) await visit(child, path);
      }
    } else if (entry.isFile) {
      try {
        const file = await read<File>(signal, (resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        signal.throwIfAborted();
        paths.set(file, path);
        files.push(file);
      } catch (error) {
        signal.throwIfAborted();
        if (refusedHidden(entry, error)) hidden.push(path);
        else errors.push(`${path}: ${error instanceof Error ? error.message : "read_failed"}`);
      }
    }
  };
  for (const entry of entries) {
    try {
      await visit(entry, "");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === "drop_too_large") throw error;
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : "read_failed"}`);
    }
  }
  return { files, directories, errors, hidden };
}
