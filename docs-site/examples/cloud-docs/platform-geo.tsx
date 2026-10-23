import { CloudMap, type CloudMapProps } from "@k2b/cloud/geo/ui";

/** Use the authorized server snapshot for the first browser render. */
export function SavedPlaceMap(props: Pick<CloudMapProps, "availability">) {
  return (
    <CloudMap
      availability={props.availability}
      height={320}
      markers={[{ id: "museum", mark: 1, label: "Museum", point: { lat: 48.4, lon: 10 } }]}
    />
  );
}
