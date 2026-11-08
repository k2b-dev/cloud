import { DescriptionBlockPreview, DescriptionPanel } from "@k2b/cloud/descriptions";
import type { JSX } from "solid-js";
import type { JsonValue } from "./examples/types";

export type ShowcaseState = "data" | "loading" | "empty" | "error" | "stale";
export const showcaseStates: readonly { value: ShowcaseState; label: string }[] = [
  { value: "data", label: "Data" },
  { value: "loading", label: "Loading" },
  { value: "empty", label: "Empty" },
  { value: "error", label: "Error" },
  { value: "stale", label: "Stale" },
];

/** The time the showcase's invented data was read, named by stale notes. */
const AS_OF = "09:12";
const cssLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);

export type ShowcaseFrameProps = {
  spec: JsonValue;
  /** Title for descriptions without one, such as map props. */
  title: string;
  subtitle?: string;
  state: ShowcaseState;
  /** Content height: pixels, or a CSS length such as a variable the dashboard grid sets per width. */
  height: number | string;
  view?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  onRetry?: () => void;
  empty?: string;
  /** What a slot stands for, such as "Sankey". */
  intended?: string;
  headingLevel?: 2 | 3 | 4;
};

/**
 * One framed panel (F4) for any portable description, drawn by Cloud's description adapter on the `@k2b/ui` dashboard
 * frame. A kind this build cannot draw keeps its frame and height and says what comes there.
 */
export function ShowcaseFrame(props: ShowcaseFrameProps): JSX.Element {
  return (
    <DescriptionPanel
      spec={props.spec}
      title={props.title}
      subtitle={props.subtitle}
      state={props.state === "data" ? "ready" : props.state}
      height={props.height}
      view={props.view}
      onViewChange={props.onViewChange}
      onRetry={props.onRetry}
      empty={props.empty}
      asOf={AS_OF}
      headingLevel={props.headingLevel}
      slot={(slot) => (
        <div class="ui-charts-slot" style={{ height: cssLength(props.height) }}>
          <span class="ui-charts-slot__kind">{slot.kind}</span>
          <strong>{props.intended ?? `The ${slot.kind} kind`} comes here</strong>
          <p>{slot.reason} The panel draws itself once the build has it.</p>
        </div>
      )}
    />
  );
}

/** A block as the overview card shows it, without a second frame. */
export const ShowcaseBlockPreview = DescriptionBlockPreview;
