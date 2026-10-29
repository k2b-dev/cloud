import SettingsSaveStatus from "@k2b/cloud/ssr/SettingsSaveStatus.island";
import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, render } from "solid-js/web";
import OperationalCharts from "../../frontend/OperationalCharts.island";
import AddWebhookButton from "../alerts/AddWebhookButton.island";
import WebhookDetail from "../alerts/WebhookDetail.island";
import HealthCheckForm from "../health-check/HealthCheckForm.island";
import LogEntryDetail from "../logs/_components/LogEntryDetail.island";
import LogTable from "../logs/_components/LogTable.island";
import RetentionForm from "../retention/RetentionForm.island";

/** Mounts the area's islands the way @k2b/ssr does: the server-rendered wrapper carries its props. */
const islands: Record<string, Component<never>> = {
  "AddWebhookButton.island.tsx": AddWebhookButton as Component<never>,
  "SettingsSaveStatus.island.tsx": SettingsSaveStatus as Component<never>,
  "HealthCheckForm.island.tsx": HealthCheckForm as Component<never>,
  "LogEntryDetail.island.tsx": LogEntryDetail as Component<never>,
  "LogTable.island.tsx": LogTable as Component<never>,
  "OperationalCharts.island.tsx": OperationalCharts as Component<never>,
  "RetentionForm.island.tsx": RetentionForm as Component<never>,
  "WebhookDetail.island.tsx": WebhookDetail as Component<never>,
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
