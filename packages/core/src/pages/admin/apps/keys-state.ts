import { createSignal } from "solid-js";

/**
 * Shared by the keys column and the create button in its head: a change in one refreshes the other. One app's keys
 * are open at a time, so one module-level state is enough.
 */
const [revision, setRevision] = createSignal(0);
const [activeCount, setActiveCount] = createSignal<number | null>(null);
const [support, setSupport] = createSignal<"ok" | "insecure" | "no-ed25519" | null>(null);
const [disabledAccount, setDisabledAccount] = createSignal<boolean | null>(null);
export const keysState = { revision, setRevision, activeCount, setActiveCount, support, setSupport, disabledAccount, setDisabledAccount };
