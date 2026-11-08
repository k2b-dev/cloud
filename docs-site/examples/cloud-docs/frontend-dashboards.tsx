import { type DescriptionJson, DescriptionPanel } from "@k2b/cloud/descriptions";
import { DashboardGrid, DashboardSection } from "@k2b/ui";

const categories = [
  { label: "Purchasing", value: 14800 },
  { label: "Staff", value: 9600 },
];
const fields: DescriptionJson[] = [
  { label: "Amount", type: "number", value: 2380, format: { style: "currency", currency: "EUR" } },
  { label: "Due", type: "date", value: "2026-11-09" },
];

export function OctoberDashboard(props: { state: "ready" | "stale"; asOf: string; reload: () => void }) {
  return (
    <DashboardGrid>
      <DashboardSection title="October" icon="ti ti-calendar-month">
        <DescriptionPanel
          spec={{ kind: "bar", title: "Out by category", data: categories }}
          title="Out by category"
          width="third"
          height={280}
          state={props.state}
          asOf={props.asOf}
          onRetry={props.reload}
          empty="Nothing went out in October."
        />
        <DescriptionPanel
          spec={{ block: "details", title: "Invoice 2026-118", items: fields }}
          title="Invoice"
          width="third"
          height={200}
        />
        <DescriptionPanel spec={{ kind: "line", title: "Balance", empty: "No account is connected yet." }} title="Balance" height={280} />
      </DashboardSection>
    </DashboardGrid>
  );
}
