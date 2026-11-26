import { LocaleProvider } from "@k2b/ui";
import { Bar, Input, Pane, Path, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import CloudShell from "./CloudShell.island";

declare global {
  interface Window {
    /** The open chat the server rendered. */
    __chat?: string;
    /** Opens another chat, or none, without a new page (the Assistant's pushState). */
    __openChat?: (chat: string | undefined) => void;
  }
}

// Over Layout's server page, the shell's header and the page mount as @k2b/ssr mounts islands: each its own root,
// which no context joins. The header first, so it shows what it has before the page's island runs.
const header = document.querySelector<HTMLElement>(".layout-header");
const main = document.querySelector<HTMLElement>("main.k2-ui");
if (!header || !main) throw new Error("Missing Layout's header or v2 content");
const [chat, setChat] = createSignal(window.__chat);
window.__openChat = (next) => setChat(next);
header.replaceChildren();
render(
  () => (
    <LocaleProvider locale="de">
      <CloudShell slot="header" authenticated pageSearch launchpad title="Gustav" {...(window.__chat ? { pageName: window.__chat } : {})} />
    </LocaleProvider>
  ),
  header,
);
document.body.dataset.headerFirst = header.querySelector(".layout-header-title")?.textContent?.trim() ?? "";
main.replaceChildren();
render(
  () => (
    <LocaleProvider locale="de">
      <Workspace
        head={
          <Bar
            start={
              <Show when={chat()}>
                {(open) => <Path label="Gustav" items={[{ label: "Gustav", href: "/app/chat" }, { label: open() }]} />}
              </Show>
            }
            end={<Input type="search" icon="search" label="Chats durchsuchen" placeholder="Chats durchsuchen" />}
          />
        }
      >
        <Pane label="Chat">
          <Text>Wie komme ich vom Flughafen in die Altstadt?</Text>
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  main,
);
document.body.dataset.mounted = "true";
