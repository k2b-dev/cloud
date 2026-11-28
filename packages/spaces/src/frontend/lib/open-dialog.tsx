import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";

/**
 * Shows a v2 `Dialog` that a deed opens from code, such as "Create template…" in a menu, and resolves with what it
 * closes with. It stands inside the page's v2 scope, so it looks like every other dialog of the page, and leaves the
 * page again when it closes.
 */
export const openDialog = <T,>(locale: string, content: (close: (value: T) => void) => JSX.Element): Promise<T> =>
  new Promise<T>((resolve) => {
    const scope = document.querySelector(".k2-ui") ?? document.body;
    const host = document.createElement("div");
    scope.append(host);
    let dispose = () => {};
    const close = (value: T) => {
      dispose();
      host.remove();
      resolve(value);
    };
    dispose = render(() => <LocaleProvider locale={locale}>{content(close)}</LocaleProvider>, host);
  });
