import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import Access from "./Access.island.tsx";
import AddApp from "./AddApp.island.tsx";
import AppRowMenu from "./AppRowMenu.island.tsx";
import Keys from "./Keys.island.tsx";
import KeysCreate from "./KeysCreate.island.tsx";
import MovedNotice from "./MovedNotice.island.tsx";
import ProviderRetry from "./ProviderRetry.island.tsx";
import ProviderValue from "./ProviderValue.island.tsx";
import Redeliver from "./Redeliver.island.tsx";
import RemoveApp from "./RemoveApp.island.tsx";

/** Mounts every Apps page island the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "Access.island.tsx": Access as Component<never>,
  "AddApp.island.tsx": AddApp as Component<never>,
  "AppRowMenu.island.tsx": AppRowMenu as Component<never>,
  "Keys.island.tsx": Keys as Component<never>,
  "KeysCreate.island.tsx": KeysCreate as Component<never>,
  "MovedNotice.island.tsx": MovedNotice as Component<never>,
  "ProviderRetry.island.tsx": ProviderRetry as Component<never>,
  "ProviderValue.island.tsx": ProviderValue as Component<never>,
  "Redeliver.island.tsx": Redeliver as Component<never>,
  "RemoveApp.island.tsx": RemoveApp as Component<never>,
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
