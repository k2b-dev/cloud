/**
 * The code a device shows, as a drawing of its own: large and in the mono face, centred in the block of its
 * question, so a person compares it with the terminal sign by sign before allowing. It stands in a `Canvas`, which the
 * page places in its band (`<Band><Canvas><DeviceCodeDrawing /></Canvas></Band>`).
 */
export function DeviceCodeDrawing(props: { code: string }) {
  return (
    <p class="oauth-device-code" data-testid="device-user-code">
      {props.code}
    </p>
  );
}
