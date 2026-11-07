import { LocaleProvider, PageTrailProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { canonicalRoute } from "../_internal/app-path";
import { getLocale } from "../server/locale";
import { resolveRuntimeRoute } from "./app-navigation";
import type { MinimalLayoutContext } from "./layout-context";
import PanelRuntime from "./PanelRuntime.island";
import { readPanelContext } from "./panel-context";
import { getRuntimeContext } from "./runtime";

export type PanelLayoutProps = {
  c: MinimalLayoutContext & { header(name: string, value: string): void };
  title: string;
  children: JSX.Element;
};

/** A provider page embedded in the shell's same-origin panel. */
export default function PanelLayout(props: PanelLayoutProps) {
  props.c.header("Referrer-Policy", "same-origin");
  const context = readPanelContext(props.c);
  const runtime = getRuntimeContext(props.c);
  // The provider owns this path by the canonical prefixes its panel declaration was checked against.
  const apps = runtime.apps.map((entry) => ({ ...entry, routes: entry.routes.map(canonicalRoute) }));
  const app = resolveRuntimeRoute(apps, new URL(props.c.req.raw.url).pathname)?.app;
  props.c.get("page").title = props.title;
  props.c.get("page").appPrimary = app?.appearance?.primary;
  return (
    <LocaleProvider locale={getLocale(props.c)}>
      {(() => {
        // As in Layout: the page renders first, so the panel page can say whether it shows its own title.
        let ownTitle = false;
        const page = (
          <PageTrailProvider trail={undefined} onOwnTitle={() => (ownTitle = true)}>
            {props.children}
          </PageTrailProvider>
        );
        return (
          <div
            class="cloud-panel-page"
            data-cloud-panel-page=""
            data-panel-provider={app?.id}
            data-k2b-title-host=""
            data-k2b-own-title={ownTitle ? "" : undefined}
          >
            <script id="cloud-panel-context" type="application/json" innerHTML={JSON.stringify(context).replace(/</g, "\\u003c")} />
            <PanelRuntime provider={app?.id} scope={app?.panel ? new URL(app.panel.href, props.c.req.raw.url).pathname : undefined} />
            {page}
          </div>
        );
      })()}
    </LocaleProvider>
  );
}
