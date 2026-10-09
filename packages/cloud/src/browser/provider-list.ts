import { createSignal } from "solid-js";
import { FileProviderError, type FileProviderSource } from "./file-providers";

/** The catalog refuses the caller, such as a visitor of a public page or a session that has just expired. */
const refused = (error: unknown) => error instanceof FileProviderError && (error.status === 401 || error.status === 403);

/**
 * One page's file providers, shared by choosing and saving: the list is loaded once and kept; a failed load is tried
 * again on the next request. A caller the catalog refuses has no providers for now, and the next request asks again,
 * because a renewed session may see them. `known` is the list once it arrived, and reactive.
 */
export const createProviderList = (loadProviders: () => Promise<FileProviderSource[]>) => {
  let request: Promise<readonly FileProviderSource[]> | undefined;
  const [known, setKnown] = createSignal<readonly FileProviderSource[] | undefined>(undefined);
  const providers = (): Promise<readonly FileProviderSource[]> => {
    request ??= loadProviders().then(
      (list) => {
        setKnown(list);
        return list;
      },
      (error: unknown) => {
        request = undefined;
        if (!refused(error)) throw error;
        setKnown([]);
        return [];
      },
    );
    return request;
  };
  return {
    providers,
    known,
    /** Whether a load is running or kept; only a refusal or a failure leaves none behind. */
    requested: () => request !== undefined,
    prefetch: () => void providers().catch(() => undefined),
  };
};

export type ProviderList = ReturnType<typeof createProviderList>;
