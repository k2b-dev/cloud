import { bottomSheetOptions, dialogCore, type DialogRender } from "@k2b/ui";

const marker = "cloudMobileMenu";
let running: Promise<void> | undefined;

/** One transient history entry; complete its Back before a selected operation runs. */
export function openMobileMenu(view: (beforeSelect: () => Promise<boolean>) => DialogRender<void>) {
  if (running) return running;
  let done: () => void = () => {};
  const cleaned = new Promise<void>((resolve) => {
    done = resolve;
  });
  running = (async () => {
    const previous = { ...history.state };
    delete previous[marker];
    history.replaceState(previous, "");
    const id = crypto.randomUUID();
    history.pushState({ ...previous, [marker]: id }, "");
    const abort = new AbortController();
    let leavingPage = false;
    const mobile = window.matchMedia("(max-width: 1023px)");
    const pop = () => {
      if (history.state?.[marker] !== id) abort.abort();
    };
    const resized = () => {
      if (!mobile.matches) abort.abort();
    };
    const leaving = () => {
      leavingPage = true;
      abort.abort();
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("pagehide", leaving);
    mobile.addEventListener("change", resized);
    try {
      await dialogCore.open<void>(
        (close, context) =>
          view(async () => {
            close();
            await cleaned;
            return !abort.signal.aborted;
          })(close, context),
        { ...bottomSheetOptions, panelClassName: `${bottomSheetOptions.panelClassName} cloud-mobile-menu`, signal: abort.signal },
      );
    } finally {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pagehide", leaving);
      mobile.removeEventListener("change", resized);
      if (!leavingPage && history.state?.[marker] === id) {
        await new Promise<void>((resolve) => {
          const returned = () => {
            window.removeEventListener("pagehide", returned);
            window.removeEventListener("popstate", returned);
            resolve();
          };
          window.addEventListener("popstate", returned, { once: true });
          window.addEventListener("pagehide", returned, { once: true });
          history.back();
        });
      }
      if (!mobile.matches && !leavingPage) {
        const launcher = document.querySelector<HTMLButtonElement>(".layout-rail [data-cloud-launchpad]");
        launcher?.focus({ preventScroll: true });
      }
      done();
      running = undefined;
    }
  })();
  return running;
}
