import { createSignal } from "solid-js";

/** One revision for every island on the page: islands share this module through the bundle's common chunk. */
export const [revision, setRevision] = createSignal(1);
