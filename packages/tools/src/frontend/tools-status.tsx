/**
 * The one live region of a Tools screen: always in the page, so assistive technology hears each new sentence (a
 * region that appears together with its text is not announced). Visually hidden; the screen shows the same state in
 * its own place. Place it in a `Canvas` (k2b-ui gap: v2 has no live region of its own).
 */
export const LiveStatus = (props: { text: string | undefined }) => (
  <p
    role="status"
    aria-live="polite"
    style={{
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      padding: "0",
      overflow: "hidden",
      clip: "rect(0 0 0 0)",
      "white-space": "nowrap",
      border: "0",
    }}
  >
    {props.text ?? ""}
  </p>
);
