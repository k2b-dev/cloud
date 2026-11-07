import { createSignal } from "solid-js";
import type { AppDomainEntry } from "./domains-model";

/** Shared by the domains column and its "Add domain" button: an added domain refreshes the list. One app is open at a time. */
const [revision, setRevision] = createSignal(0);
const [domains, setDomains] = createSignal<readonly AppDomainEntry[] | null>(null);
/** The host of the change running now; while it runs and the list is read again, no other change starts. */
const [busy, setBusy] = createSignal<string | null>(null);
export const domainsState = { revision, setRevision, domains, setDomains, busy, setBusy };
