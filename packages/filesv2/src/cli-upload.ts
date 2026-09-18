import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import type { EntryResult, UploadSession } from "./contracts";

// DirectSession calls its fetch as a method; keep the global binding.
const transfer = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init), { preconnect: fetch.preconnect }) as typeof fetch;

/** Cloud opens and commits the session; file segments go straight to Filegate without a Cloud token. */
export async function uploadFile(
  ctx: CloudCliContext,
  input: string,
  api: {
    open: (size: number, signal: AbortSignal) => Promise<UploadSession>;
    renew: (id: string) => Promise<{ url: string }>;
    commit: (id: string) => Promise<EntryResult>;
    abort: (id: string) => Promise<void>;
  },
) {
  const path = resolve(input);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(cliText(ctx, { en: "The input path is not a file.", de: "Der Eingabepfad ist keine Datei." }));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const session = await api.open(info.size, controller.signal);
  try {
    const url = new URL(session.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    const handle = await open(path);
    try {
      const blob = new Blob([await handle.readFile()]);
      let leaseUrl = session.url;
      for (;;) {
        try {
          await new DirectSession(leaseUrl, transfer).upload(blob, { signal: controller.signal });
          break;
        } catch (error) {
          if (!(error instanceof FilegateError && (error.status === 401 || error.status === 403))) throw error;
          leaseUrl = (await api.renew(session.id)).url;
        }
      }
    } finally {
      await handle.close();
    }
    return await api.commit(session.id);
  } catch (error) {
    await api.abort(session.id).catch(() => {});
    if (controller.signal.aborted) throw new Error(cliText(ctx, { en: "Upload cancelled.", de: "Upload abgebrochen." }));
    throw error instanceof Error && error.message ? error : new Error(cliText(ctx, { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." }));
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
