import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import CoreSettingsForm from "../settings/_components/CoreSettingsForm.island.tsx";
import CodeApprovalReview from "./CodeApprovalReview.island.tsx";
import CodeListFilters from "./CodeListFilters.island.tsx";
import CodePauseAction from "./CodePauseAction.island.tsx";
import CodePolicyEditor from "./CodePolicyEditor.island.tsx";
import CodePolicyPicker from "./CodePolicyPicker.island.tsx";

/** Mounts every Code area island the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "CodeApprovalReview.island.tsx": CodeApprovalReview as Component<never>,
  "CodeListFilters.island.tsx": CodeListFilters as Component<never>,
  "CodePauseAction.island.tsx": CodePauseAction as Component<never>,
  "CodePolicyEditor.island.tsx": CodePolicyEditor as Component<never>,
  "CodePolicyPicker.island.tsx": CodePolicyPicker as Component<never>,
  "CoreSettingsForm.island.tsx": CoreSettingsForm as Component<never>,
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
