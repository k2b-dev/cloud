import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Button, Input } from "../src/v2";
import { AccessScreen, type AccessSort } from "./v2-access.fixture";

// The access screen in the browser: the heads sort in place, "Bild ändern" turns busy on a press until the test ends
// it, and the hooks count what the screen asked for. Beside it two forms of one field and a submit button, one of them
// busy: Enter in the field sends the form whose button is not busy, and only that one.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** How often each deed ran: a sort, the picture button, the disabled deed of the notice, each form sent. */
    __k2Counts?: { sort: number; picture: number; resume: number; sentBusy: number; sentIdle: number };
    /** Ends the busy state of the picture button. */
    __k2Done?: () => void;
  }
}

const counts = { sort: 0, picture: 0, resume: 0, sentBusy: 0, sentIdle: 0 };
window.__k2Counts = counts;
const [sort, setSort] = createSignal<AccessSort>({ column: 0, direction: "ascending" });
const [busy, setBusy] = createSignal(false);
window.__k2Done = () => setBusy(false);

const root = document.getElementById("root");
if (!root) throw new Error("access: #root is missing");
render(
  () => (
    <AccessScreen
      sort={sort()}
      busy={busy()}
      onSort={(column) => {
        counts.sort++;
        setSort((now) => ({
          column,
          direction: now.column === column && now.direction === "ascending" ? "descending" : "ascending",
        }));
      }}
      onPicture={() => {
        counts.picture++;
        setBusy(true);
      }}
      onResume={() => {
        counts.resume++;
      }}
    />
  ),
  root,
);

const forms = document.createElement("div");
document.body.append(forms);
render(
  () => (
    <>
      <form
        id="busy-form"
        onSubmit={(event) => {
          event.preventDefault();
          counts.sentBusy++;
        }}
      >
        <Input label="Name beim Speichern" value="Wochenbericht" />
        <Button type="submit" busy>
          Speichern
        </Button>
      </form>
      <form
        id="idle-form"
        onSubmit={(event) => {
          event.preventDefault();
          counts.sentIdle++;
        }}
      >
        <Input label="Name" value="Wochenbericht" />
        <Button type="submit">Senden</Button>
      </form>
    </>
  ),
  forms,
);
window.__k2Mounted = true;
