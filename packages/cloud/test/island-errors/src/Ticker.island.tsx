import { isServer } from "solid-js/web";
import { revision, setRevision } from "./probe-store";

/** Writes the shared revision that the feed islands load. */
export default function Ticker() {
  return (
    <p data-mounted={isServer ? undefined : ""}>
      <output data-testid="revision">{revision()}</output>
      <button type="button" onClick={() => setRevision((current) => current + 1)}>
        Next revision
      </button>
    </p>
  );
}
