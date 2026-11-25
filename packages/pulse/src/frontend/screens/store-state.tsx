import { Chip } from "@k2b/ui/v2";
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
  return <Chip status={state().status ?? "ok"}>{state().label}</Chip>;
};

/** The data colour of a base, from its colour setting, for its symbol in lists. */
export const baseColor = (color: string): string =>
  ({ zinc: "#52525b", blue: "#2563eb", emerald: "#059669", amber: "#d97706", red: "#dc2626" })[color] ?? "#2563eb";
