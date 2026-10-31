import { createSignal } from "solid-js";
import type { AppDomainEntry } from "./domains-model";

/** Shared by the domains column and its "Add domain" button: an added domain refreshes the list. One app is open at a time. */
const [revision, setRevision] = createSignal(0);
const [domains, setDomains] = createSignal<readonly AppDomainEntry[] | null>(null);
export const domainsState = { revision, setRevision, domains, setDomains };
