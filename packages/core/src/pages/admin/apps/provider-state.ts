import { createSignal } from "solid-js";

/** Numbers of the app page's provider rows after "Try again"; shared by the retry button and the values it refreshes. */
export type ProviderParts = { traffic: string | null; errors: string | null; errorsTone?: "danger"; unavailable: boolean };

const [retrying, setRetrying] = createSignal(false);
const [refreshed, setRefreshed] = createSignal<ProviderParts | null>(null);
export { refreshed, retrying, setRefreshed, setRetrying };
