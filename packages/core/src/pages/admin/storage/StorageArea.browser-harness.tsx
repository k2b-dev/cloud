import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import RegistryForm from "../_area/RegistryForm.island.tsx";
import StorageBucketDetail from "./StorageBucketDetail.island.tsx";
import StorageDefaultDetail from "./StorageDefaultDetail.island.tsx";
import StorageDetailActions from "./StorageDetailActions.island.tsx";

/** Mounts every Storage area island the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "RegistryForm.island.tsx": RegistryForm,
  "StorageBucketDetail.island.tsx": StorageBucketDetail,
  "StorageDefaultDetail.island.tsx": StorageDefaultDetail,
  "StorageDetailActions.island.tsx": StorageDetailActions,
};
for (const element of document.querySelectorAll<HTMLElement>("solid-island")) {
  const island = islands[element.dataset.file ?? ""];
  if (!island) continue;
  const props = fromJSON<never>(JSON.parse(element.dataset.props ?? "{}"));
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
