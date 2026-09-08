import { DescriptionList, Paper } from "@k2b/ui";
import type { JSX } from "solid-js";

type Props = {
  facts: Array<{ label: string; value: JSX.Element }>;
  viewTransitionName?: string;
};

export default function AccountsFactGrid(props: Props) {
  return (
    <Paper class="p-4" style={props.viewTransitionName ? { "view-transition-name": props.viewTransitionName } : undefined}>
      <DescriptionList columns={3} items={props.facts.map((fact) => ({ term: fact.label, description: fact.value }))} />
    </Paper>
  );
}
