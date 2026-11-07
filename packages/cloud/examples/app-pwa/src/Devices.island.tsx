import { createStaffApi } from "./http";
import Staff, { type DevicePage } from "./Staff";

export default function DevicesIsland(props: { publicOrigin: string; initial: DevicePage; initialError: boolean }) {
  return <Staff initial={props.initial} initialError={props.initialError} api={createStaffApi({ publicOrigin: props.publicOrigin })} />;
}
