import type { IslandErrorProps } from "@k2b/ssr";
import { i18n } from "@k2b/stdlib";
import { Failed, useLocale } from "@k2b/ui/v2";
import { onCleanup, onMount } from "solid-js";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { title: "This section could not be displayed." },
    de: { title: "Dieser Bereich konnte nicht angezeigt werden." },
  },
});

/**
 * Takes the place of an island or client component whose rendering failed.
 * `defineApp` hands it to @k2b/ssr as `errorFallback`, so every island of every
 * app gets it and loads its code with the island's own; the locale comes from
 * `<html lang>`. "Retry" remounts the island with its original props.
 *
 * It is the v2 `Failed` state and loads no v1 module, so a v2 island carries no v1
 * code for it (`island-imports.bundle.test.ts`). Every Cloud page loads v2.css;
 * outside a v2 page the island's own element takes the `.k2-ui` scope while the
 * notice stands, so `Failed` sits directly in the island: after "Retry" its focus
 * goes on to what the island renders again.
 */
export default function IslandError(props: IslandErrorProps) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const failed = <Failed text={t().title} onRetry={() => props.reset()} />;
  onMount(() => {
    const island = failed instanceof Element ? failed.parentElement : null;
    if (!island || island.closest(".k2-ui")) return;
    island.classList.add("k2-ui");
    onCleanup(() => island.classList.remove("k2-ui"));
  });
  return failed;
}
