import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { getLocale } from "../server/locale";
import { resolveCurrentApp } from "./app-appearance";
import type { MinimalLayoutContext } from "./layout-context";
import PanelRuntime from "./PanelRuntime.island";
import { getRuntimeContext } from "./runtime";

export type PanelLayoutProps = { c: MinimalLayoutContext; title: string; children: JSX.Element };

/** A provider page embedded in the shell's same-origin panel. */
export default function PanelLayout(props: PanelLayoutProps) {
  const runtime = getRuntimeContext(props.c);
  const app = resolveCurrentApp(runtime.apps, new URL(props.c.req.raw.url).pathname);
  props.c.get("page").title = props.title;
  return (
    <LocaleProvider locale={getLocale(props.c)}>
      <div class="cloud-panel-page" data-cloud-panel-page="" data-panel-provider={app?.id}>
        <PanelRuntime provider={app?.id} />
        {props.children}
      </div>
    </LocaleProvider>
  );
}
