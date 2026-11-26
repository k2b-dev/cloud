import type { IslandErrorProps } from "@k2b/ssr";
import { i18n } from "@k2b/stdlib";
import { Failed, useLocale } from "@k2b/ui/v2";
import { onMount } from "solid-js";

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
 * code for it (`IslandError.bundle.test.ts`). Every Cloud page loads v2.css: outside
 * a v2 page the wrapper gives `Failed` its `.k2-ui` scope, inside one it keeps the
 * page's scope.
 */
export default function IslandError(props: IslandErrorProps) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  let scope!: HTMLDivElement;
  onMount(() => {
    if (scope.parentElement?.closest(".k2-ui")) scope.classList.remove("k2-ui");
  });
  return (
    <div ref={scope} class="k2-ui" style={{ display: "contents" }}>
      <Failed text={t().title} onRetry={() => props.reset()} />
    </div>
  );
}
