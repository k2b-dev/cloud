import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import type { SecretTitles } from "../secret-titles";

/**
 * The automation titles the outcome lines name. The page's request loads them for the first frame; a chat opened
 * without a reload asks for a missing one once. `null` means Core says it is gone or no longer readable.
 */
export function createSecretTitleStore(initial: SecretTitles = {}) {
  const [titles, setTitles] = createSignal<SecretTitles>({ ...initial });
  const asked = new Set(Object.keys(initial));
  return {
    title: (codeId: string): string | null | undefined => titles()[codeId],
    want(codeId: string) {
      if (isServer || asked.has(codeId)) return;
      asked.add(codeId);
      void (async () => {
        const [{ loadSecretTitles }, { browserCodeInvoke }] = await Promise.all([
          import("../secret-titles"),
          import("../frontend/code-client"),
        ]);
        const loaded = await loadSecretTitles(browserCodeInvoke, [codeId]);
        if (codeId in loaded) setTitles((current) => ({ ...current, ...loaded }));
      })().catch(() => {
        /* No answer keeps the line's general words; the next chat load asks again. */
      });
    },
  };
}
export type SecretTitleStore = ReturnType<typeof createSecretTitleStore>;
