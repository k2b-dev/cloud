import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import SignInLocations from "../settings/_components/SignInLocations";

/** Where sign-ins come from: the GeoIP databases below the sign-in settings. */
export default function SignInLocationsIsland(props: { status: GeoIpAdminStatus | null; actorId: string }) {
  return <SignInLocations initial={props.status} actorId={props.actorId} />;
}
