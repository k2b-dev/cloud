import { onMount } from "solid-js";
import type { MaintenanceGameTexts } from "../maintenance-game";
import { loadMaintenanceGame } from "./maintenance-game-loader";

export type WaitingGameProps = { t: MaintenanceGameTexts };

/**
 * The waiting game below a generic error page: the robot waits on its road, and Space or a tap starts a round. The
 * server renders the scene's box at its final size, so the page does not move when the game code arrives.
 */
export default function WaitingGame(props: WaitingGameProps) {
  let host: HTMLDivElement | undefined;
  onMount(() => {
    void loadMaintenanceGame().then((factory) => {
      if (!factory || !host) return;
      factory({
        host,
        anchor: () => null,
        t: props.t,
        dark: () => document.documentElement.classList.contains("dark"),
        // These pages never end a maintenance, so a round never waits for one.
        onFinish: () => {},
      }).open();
    });
  });
  return <div ref={host} class="relative isolate h-[clamp(20rem,52vh,32rem)] w-full shrink-0" data-waiting-game />;
}
