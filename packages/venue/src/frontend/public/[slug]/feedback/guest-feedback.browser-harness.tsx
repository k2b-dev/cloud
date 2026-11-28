import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import GuestFeedback, { type GuestFeedbackProps } from "./GuestFeedback.island";

// The feedback form's island as the browser runs it on the server's page: the test's props, rendered into the island
// the server left, in place of hydration.
const island = document.querySelector('solid-island[data-file="GuestFeedback.island.tsx"]');
const props = JSON.parse(document.getElementById("island-props")?.textContent ?? "null") as GuestFeedbackProps | null;
if (!island || !props) throw new Error("guest feedback harness: the island or its props are missing");
island.textContent = "";
render(
  () => (
    <LocaleProvider locale="de">
      <GuestFeedback {...props} />
    </LocaleProvider>
  ),
  island,
);
document.body.dataset.islandReady = "";
