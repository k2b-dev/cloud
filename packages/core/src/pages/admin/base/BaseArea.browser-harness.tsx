import SettingsSaveStatus from "@k2b/cloud/ssr/SettingsSaveStatus.island";
import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import RegistryForm from "../_area/RegistryForm.island";
import TestFreeIpaButton from "../signin/TestFreeIpaButton.island";
import BaseScreen, { type BaseScreenProps } from "./BaseScreen";

/** Mounts the area's islands the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "RegistryForm.island.tsx": RegistryForm as Component<never>,
  "SettingsSaveStatus.island.tsx": SettingsSaveStatus as Component<never>,
  "TestFreeIpaButton.island.tsx": TestFreeIpaButton as Component<never>,
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
// A Base section on v2: the screen mounts fresh in the page's main area with the props the server rendered.
const screen = document.getElementById("base-screen-props");
const main = document.querySelector<HTMLElement>("main.k2-ui");
if (screen && main) {
  const props = JSON.parse(screen.textContent ?? "{}") as BaseScreenProps;
  main.replaceChildren();
  render(
    () =>
      createComponent(LocaleProvider, {
        locale: document.documentElement.lang,
        get children() {
          return createComponent(BaseScreen, props);
        },
      }),
    main,
  );
}
document.body.dataset.ready = "true";
