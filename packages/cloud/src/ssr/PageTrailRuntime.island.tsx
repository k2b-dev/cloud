import { followPageTrail, installPageTitleController, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { installPageTrailRuntime } from "./page-trail-runtime";
import { platformMessages } from "./platform-messages";

/**
 * One owner per document for the way up: it collapses every page title path
 * to its space, keeps server-rendered workspace heads current after
 * `layout.update()`, runs the per-tab memory behind up links, and offers
 * "One level up" (Alt+↑) while the page has a page above it.
 */
export default function PageTrailRuntime() {
  const locale = useLocale();
  onMount(() => {
    const t = platformMessages.resolve([locale()]).t;
    const disposeTitles = installPageTitleController(document);
    const disposeFollow = followPageTrail(document);
    const disposeRuntime = installPageTrailRuntime((page) => ({ title: t.pageUp({ page }), description: t.pageUpDescription }));
    onCleanup(() => {
      disposeTitles();
      disposeFollow();
      disposeRuntime();
    });
  });
  return null;
}
