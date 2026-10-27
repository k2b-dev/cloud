import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import AiAreaActions from "./AiAreaActions.island.tsx";
import AiBudgetDetail from "./AiBudgetDetail.island.tsx";
import AiBudgetToggle from "./AiBudgetToggle.island.tsx";
import AiClassDetail from "./AiClassDetail.island.tsx";
import AiConnectionDetail from "./AiConnectionDetail.island.tsx";
import AiDetailActions from "./AiDetailActions.island.tsx";
import AiModelDetail from "./AiModelDetail.island.tsx";
import AiProviderNotice from "./AiProviderNotice.island.tsx";

/** Mounts every AI area island the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "AiAreaActions.island.tsx": AiAreaActions as Component<never>,
  "AiBudgetDetail.island.tsx": AiBudgetDetail as Component<never>,
  "AiBudgetToggle.island.tsx": AiBudgetToggle as Component<never>,
  "AiClassDetail.island.tsx": AiClassDetail as Component<never>,
  "AiConnectionDetail.island.tsx": AiConnectionDetail as Component<never>,
  "AiDetailActions.island.tsx": AiDetailActions as Component<never>,
  "AiModelDetail.island.tsx": AiModelDetail as Component<never>,
  "AiProviderNotice.island.tsx": AiProviderNotice as Component<never>,
};
for (const element of document.querySelectorAll<HTMLElement>("solid-island")) {
  const island = islands[element.dataset.file ?? ""];
  if (!island) continue;
  const props = fromJSON(JSON.parse(element.dataset.props ?? "{}")) as never;
  element.replaceChildren();
  render(
    () =>
      createComponent(LocaleProvider, {
        locale: document.documentElement.lang,
        get children() {
          return createComponent(island, props);
        },
      }),
    element,
  );
}
document.body.dataset.ready = "true";
