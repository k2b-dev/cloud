/**
 * The code a device shows, as a drawing of its own: large and in the mono face, on a strip of its own across the
 * column, so a person compares it with the terminal sign by sign before allowing. It stands in a `Canvas`, which the
 * page places in its band (`<Band><Canvas><DeviceCodeDrawing /></Canvas></Band>`).
 */
export function DeviceCodeDrawing(props: { code: string }) {
  return (
    <p class="oauth-device-code" data-testid="device-user-code">
      {props.code}
    </p>
  );
}
