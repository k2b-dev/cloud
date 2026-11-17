import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { RunLogDemos } from "../../../docs-site/src/ui/demo-sections/run-log";
import { RunLog, type RunLogProps } from "../src/content/RunLog";
import { LocaleProvider } from "../src/intl/locale";

declare global {
  interface Window {
    __runLog: { set: (value: RunLogProps) => void };
  }
}

function Fixture() {
  const [props, setProps] = createSignal<RunLogProps>({ state: "idle", entries: [] });
  window.__runLog = { set: setProps };
  return (
    <LocaleProvider locale="de">
      <div data-k2b-primary="ai">
        <RunLog {...props()} />
        <p id="below">Danach</p>
      </div>
    </LocaleProvider>
  );
}
render(() => <Fixture />, document.getElementById("test-root")!);
render(() => <RunLogDemos />, document.getElementById("catalog-root")!);
