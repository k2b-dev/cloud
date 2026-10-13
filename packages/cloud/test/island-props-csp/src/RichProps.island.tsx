import { isServer } from "solid-js/web";

export type RichProps = {
  at: Date;
  map: Map<string, { label: string }>;
  set: Set<string>;
  shared: { label: string };
  missing: undefined;
  text: string;
};

export default function RichProps(props: RichProps) {
  return (
    <section data-rich-props data-mounted={isServer ? undefined : "true"}>
      <span data-date>{props.at.getTime()}</span>
      <span data-map>{JSON.stringify([...props.map])}</span>
      <span data-set>{JSON.stringify([...props.set])}</span>
      <span data-shared>{String(props.shared === props.map.get("k"))}</span>
      <span data-undefined>{String("missing" in props && props.missing === undefined)}</span>
      <span data-text>{props.text}</span>
    </section>
  );
}
