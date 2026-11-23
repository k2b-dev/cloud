import { createSignal } from "solid-js";

/** The "Bausteine zeigen" switch of a Fibel demo page: it turns the inspect layer on inside every framed screen. */
export default function V2InspectSwitch(props: { frames: readonly string[] }) {
  const [on, setOn] = createSignal(false);
  const send = (value: boolean) => {
    for (const id of props.frames) {
      const frame = document.getElementById(id) as HTMLIFrameElement | null;
      frame?.contentWindow?.postMessage({ type: "k2-inspect", on: value }, location.origin);
    }
  };
  return (
    <label class="ui-v2-inspect-toggle">
      <input
        type="checkbox"
        checked={on()}
        onChange={(event) => {
          setOn(event.currentTarget.checked);
          send(event.currentTarget.checked);
        }}
      />
      Bausteine zeigen
    </label>
  );
}
