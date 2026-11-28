import { Text } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * A state that needs nothing from anyone, such as "Läuft" or "Erreichbar": a neutral dot and its word (identity B,
 * rule 7). Colour and chips stay for problems; a quieter state (not started, expired) passes `muted`.
 */
export default function StateWord(props: { muted?: boolean; children: JSX.Element }) {
  return (
    <Text muted={props.muted}>
      {/* a small grey dot, as the study writes it (the icon font has no filled point) */}
      <Text type="meta" muted>
        ●
      </Text>{" "}
      {props.children}
    </Text>
  );
}

/**
 * The dot before the word of a state that needs someone, such as "Kein Admin" in red: small, in the colour of the word
 * around it. It is a character, as in `StateWord`: the icon font has no filled point (#4558).
 */
export const StateDot = () => <Text type="meta">●</Text>;
