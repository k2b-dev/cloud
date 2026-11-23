import { createSignal } from "solid-js";

/** The "Bausteine zeigen" switch of a Fibel demo page: it turns the inspect layer on inside the framed screen. */
export default function V2InspectSwitch(props: { frame: string }) {
  const [on, setOn] = createSignal(false);
  const send = (value: boolean) => {
    const frame = document.getElementById(props.frame) as HTMLIFrameElement | null;
    frame?.contentWindow?.postMessage({ type: "k2-inspect", on: value }, location.origin);
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
