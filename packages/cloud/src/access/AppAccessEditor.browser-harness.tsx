import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CloudShell from "../ssr/CloudShell.island";
import ShellRuntime from "../ssr/ShellRuntime.island";
import AppAccessEditor, { type AppAccessEditorProps } from "./AppAccessEditor";

// The editor transport is synthetic. Discovery instead receives the real, server-filtered shell payload.
const data = document.querySelector<HTMLScriptElement>("#app-access-fixture-data");
if (!data) throw new Error("Missing app-access fixture data");
const root = document.querySelector<HTMLElement>("#app-access-fixture");
const discovery = document.querySelector<HTMLElement>("#app-access-discovery-fixture");
if (discovery) {
  // Keep Layout's SSR frames and phone navigation; mount the same interactive shell components inside them.
  const rail = document.querySelector<HTMLElement>(".layout-rail-navigation");
  const header = document.querySelector<HTMLElement>(".layout-header");
  if (!rail || !header) throw new Error("Missing discovery shell frames");
  const railHost = document.createElement("div");
  railHost.className = "contents";
  rail.replaceWith(railHost);
  header.replaceChildren();
  render(
    () => (
      <LocaleProvider locale={document.documentElement.lang}>
        <CloudShell slot="rail" currentPath={`${location.pathname}${location.search}`} />
      </LocaleProvider>
    ),
    railHost,
  );
  render(
    () => (
      <LocaleProvider locale={document.documentElement.lang}>
        <CloudShell slot="header" authenticated launchpad title="Cloud" />
      </LocaleProvider>
    ),
    header,
  );
  render(
    () => (
      <LocaleProvider locale={document.documentElement.lang}>
        {/* This fixture verifies shell navigation search; federated provider authorization has separate server tests. */}
        <ShellRuntime commands={{ searchResources: false }} />
      </LocaleProvider>
    ),
    discovery,
  );
  discovery.dataset.ready = "true";
} else {
  if (!root) throw new Error("Missing app-access editor mount");
  const props: AppAccessEditorProps = JSON.parse(data.textContent!);
  root.replaceChildren();
  render(
    () => (
      <LocaleProvider locale={document.documentElement.lang}>
        <AppAccessEditor
          {...props}
          onAccessLost={() => {
            root.dataset.accessLost = "true";
          }}
        />
      </LocaleProvider>
    ),
    root,
  );
  root.dataset.ready = "true";
}
