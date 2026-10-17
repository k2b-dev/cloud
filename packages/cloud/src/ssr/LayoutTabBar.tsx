import CloudShell from "./CloudShell.island";

/**
 * The signed-in phone's bottom bar: Home and the person's first apps in their rail order, floating on the app
 * gradient above the content card. The frame is server markup; the bar inside is the shell's island, so it follows
 * the person's rail preferences when they change them. The place of the app's primary action beside it stays free.
 * From 768 px the rail takes over and the bar is hidden.
 */
export default function LayoutTabBar(props: { currentPath: string }) {
  return (
    <div class="cloud-tab-bar">
      <div class="cloud-tab-bar__row">
        <CloudShell slot="bar" currentPath={props.currentPath} />
      </div>
    </div>
  );
}
