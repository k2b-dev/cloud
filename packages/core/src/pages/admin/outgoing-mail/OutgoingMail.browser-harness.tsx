import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import OutgoingMail, { type OutgoingMailState } from "./OutgoingMail.island.tsx";

const data = document.querySelector<HTMLScriptElement>("#outgoing-mail-fixture-data")!;
const initial: OutgoingMailState = JSON.parse(data.textContent!);
const root = document.querySelector<HTMLElement>("#outgoing-mail-fixture")!;
root.replaceChildren();
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <OutgoingMail initial={initial} />
    </LocaleProvider>
  ),
  root,
);
root.dataset.ready = "true";
