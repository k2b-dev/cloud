import type { JSX } from "solid-js";

export type StepsProps = { children: JSX.Element; start?: number; class?: string };
/**
 * An ordered instruction list with accent numbers. Trusted HTML can use the same class.
 * @example <Steps start={2}><li>Select Share.</li><li>Copy the link.</li></Steps>
 */
export function Steps(props: StepsProps): JSX.Element {
  return (
    <ol class={`k2b-steps${props.class ? ` ${props.class}` : ""}`} start={props.start} style={{ "--k2b-steps-start": props.start }}>
      {props.children}
    </ol>
  );
}
export default Steps;
