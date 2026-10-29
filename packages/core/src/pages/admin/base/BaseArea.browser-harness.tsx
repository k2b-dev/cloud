import SettingsSaveStatus from "@k2b/cloud/ssr/SettingsSaveStatus.island";
import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import RegistryForm from "../_area/RegistryForm.island";
import LegacySettings from "./LegacySettings.island";
import TestPdfButton from "./TestPdfButton.island";

/** Mounts the area's islands the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "LegacySettings.island.tsx": LegacySettings as Component<never>,
  "RegistryForm.island.tsx": RegistryForm as Component<never>,
  "SettingsSaveStatus.island.tsx": SettingsSaveStatus as Component<never>,
  "TestPdfButton.island.tsx": TestPdfButton as Component<never>,
};
for (const element of document.querySelectorAll<HTMLElement>("solid-island")) {
  const island = islands[element.dataset.file?.split("/").pop() ?? ""];
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
