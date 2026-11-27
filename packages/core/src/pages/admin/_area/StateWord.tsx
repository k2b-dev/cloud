import { Text } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * A state that needs nothing from anyone, such as "Läuft" or "Erreichbar": a neutral dot and its word (identity B,
 * rule 7). Colour and chips stay for problems; a quieter state (not started, expired) passes `muted`.
 */
export default function StateWord(props: { muted?: boolean; children: JSX.Element }) {
  return (
    <Text muted={props.muted}>
      {/* the study writes the dot as a sign; the icon font has no filled point */}● {props.children}
    </Text>
  );
}
