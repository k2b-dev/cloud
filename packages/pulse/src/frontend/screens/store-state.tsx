import { Chip, Text } from "@k2b/ui/v2";
import type { BaseStoreStatus } from "../../store/admin-contracts";
import type { baseStoreMessages } from "../workspace/base-store-messages";

type StoreWords = ReturnType<typeof baseStoreMessages.resolve>["t"];

/** A base's data store in one word with its meaning: active is ok, running work waits, a failure or block is wrong. */
export const storeState = (store: BaseStoreStatus, t: StoreWords): { status?: "ok" | "warn" | "bad"; label: string } => {
  if (store.state === "failed") return { status: "bad", label: t.stateFailed };
  if (store.state === "active")
    return store.writeBlockReason ? { status: "warn", label: t.stateWriteBlocked } : { status: "ok", label: t.stateActive };
  return {
    status: "warn",
    label: { provisioning: t.stateProvisioning, clearing: t.stateClearing, deleting: t.stateDeleting }[store.state],
  };
};

export const StoreChip = (props: { store: BaseStoreStatus; t: StoreWords }) => {
  const state = () => storeState(props.store, props.t);
  // an active store says so quietly, without colour (identity B, rule 7); only what needs a look gets a chip
  return state().status === "ok" ? <Text>{state().label}</Text> : <Chip status={state().status ?? "warn"}>{state().label}</Chip>;
};

/** The data colour of a base, from its colour setting, for its symbol in lists. */
export const baseColor = (color: string): string =>
  ({ zinc: "#52525b", blue: "#2563eb", emerald: "#059669", amber: "#d97706", red: "#dc2626" })[color] ?? "#2563eb";

/** v1 icon classes ("ti ti-database") to v2 Tabler names ("database"). */
export const iconName = (classes: string) => classes.replace(/^ti\s+/, "").replace(/^ti-/, "") || "activity-heartbeat";
