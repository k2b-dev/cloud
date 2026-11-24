import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { AccessScreen, type AccessSort } from "./v2-access.fixture";

// The access screen in the browser: the heads sort in place, "Bild ändern" turns busy on a press until the test ends
// it, and the hooks count what the screen asked for.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** How often each deed ran: a sort, the picture button, the disabled deed of the notice. */
    __k2Counts?: { sort: number; picture: number; resume: number };
    /** Ends the busy state of the picture button. */
    __k2Done?: () => void;
  }
}

const counts = { sort: 0, picture: 0, resume: 0 };
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
window.__k2Mounted = true;
