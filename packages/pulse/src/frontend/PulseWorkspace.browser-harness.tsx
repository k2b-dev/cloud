import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import PulseWorkspace from "./PulseWorkspace.island";
import type { PulseWorkspaceProps } from "./workspace/types";

// The browser test passes the server snapshot and the locale in the page's own script tag.
const snapshot = (window as unknown as { __pulse: { locale: string; props: PulseWorkspaceProps } }).__pulse;
const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={snapshot.locale}>
      <PulseWorkspace {...snapshot.props} />
    </LocaleProvider>
  ),
  root,
);
