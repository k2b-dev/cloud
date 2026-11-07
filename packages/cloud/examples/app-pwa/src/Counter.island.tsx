import { createKioskApi } from "./http";
import Kiosk from "./Kiosk";

export const NEUTRAL_SNAPSHOT = { device: null, visit: null };
/** Serializable public configuration only; no guest credential or customer SSR data. */
export default function CounterIsland(props: { publicOrigin: string }) {
  return <Kiosk initial={NEUTRAL_SNAPSHOT} api={createKioskApi({ publicOrigin: props.publicOrigin })} />;
}
