import type { StyleSpecification } from "maplibre-gl";
import type { JSX } from "solid-js";

export type MapViewPoint = { lat: number; lon: number };
export type MapViewTone = "accent" | "second" | "neutral" | "warning";
export type MapViewMarker = {
  id: string;
  point: MapViewPoint;
  /** A number, a single letter, or "+". Omit for a drop pin. */
  mark?: number | string;
  label: string;
  tone?: MapViewTone;
  selected?: boolean;
};
export type MapViewLineTone = "accent" | "muted" | "preview" | "previous";
export type MapViewLine = { id: string; tone?: MapViewLineTone } & ({ polyline6: string } | { points: MapViewPoint[] });
export type MapViewArea = { id: string; polygon: MapViewPoint[]; tone?: MapViewTone };
export type MapViewOwnLocation = { point: MapViewPoint; accuracyMeters?: number };
export type MapViewStyle = string | StyleSpecification;
export type MapViewStyleSource = MapViewStyle | { light: MapViewStyle; dark: MapViewStyle };
export type MapViewFit = "all" | "markers";
export type MapViewFrameProps = {
  markers?: MapViewMarker[];
  lines?: MapViewLine[];
  areas?: MapViewArea[];
  ownLocation?: MapViewOwnLocation;
  height: number;
  padding?: number;
  fit?: MapViewFit;
  selectedId?: string;
  attribution?: JSX.Element;
  class?: string;
};
export type MapViewProps = Omit<MapViewFrameProps, "attribution"> & {
  style: MapViewStyleSource;
  attribution: JSX.Element;
  onSelect?: (id: string) => void;
  infoTile?: (marker: MapViewMarker) => JSX.Element;
  notice?: JSX.Element;
  empty?: JSX.Element;
  onLocate?: () => void;
};
