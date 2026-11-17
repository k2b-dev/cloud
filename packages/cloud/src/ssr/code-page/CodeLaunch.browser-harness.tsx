import { LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { CodeLiveFeed, CodeLiveRun } from "./CodeLiveStrip";
import CodePage from "./CodePage";
import { HEAD_STATES, type HeadState, headActionFixture } from "./head-action.fixture";

declare global {
  interface Window {
    codeHead: { show: (state: HeadState) => void; run: (run: CodeLiveRun) => void };
  }
}
const params = new URL(location.href).searchParams;
const locale = params.get("locale") ?? "de";
const [name, setName] = createSignal(HEAD_STATES.find((state) => state === params.get("state")) ?? "schedule");
const data = createMemo(() => headActionFixture(name(), locale));
let feed: CodeLiveFeed | undefined;
window.codeHead = { show: setName, run: (run) => feed?.run(run) };
render(
  () => (
    <LocaleProvider locale={locale}>
      <div data-k2b-primary={name() === "mailbox" ? undefined : "ai"}>
        <CodePage
          data={data()}
          onLive={(live) => {
            feed = live;
            return undefined;
          }}
        />
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
