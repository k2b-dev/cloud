import { useLocale } from "@k2b/ui";
import { Tabs } from "@k2b/ui/v2";
import { natsMessages } from "../nats/messages";
import { areaMessages } from "./area-messages";

/** The infrastructure record: an overview and one area per backend, each with its own address. */
export const INFRA_HREF = {
  overview: "/admin/observability/infrastructure",
  postgres: "/admin/observability/infrastructure/postgres",
  valkey: "/admin/observability/infrastructure/valkey",
  nats: "/admin/observability/infrastructure/nats",
  access: "/admin/observability/infrastructure/nats-access",
} as const;
export type InfraArea = keyof typeof INFRA_HREF;

/** The areas of the infrastructure record in the head. */
export function InfrastructureTabs(props: { current: InfraArea }) {
  const locale = useLocale();
  const area = () => areaMessages.resolve([locale()]).t;
  const nats = () => natsMessages.resolve([locale()]).t;
  return (
    <Tabs
      label={area().infrastructure}
      items={[
        { label: area().home, icon: "layout-dashboard", href: INFRA_HREF.overview, current: props.current === "overview" },
        { label: "Postgres", icon: "database", href: INFRA_HREF.postgres, current: props.current === "postgres" },
        { label: "Valkey", icon: "database", href: INFRA_HREF.valkey, current: props.current === "valkey" },
        { label: "NATS", icon: "topology-star-3", href: INFRA_HREF.nats, current: props.current === "nats" },
        { label: nats().access, icon: "key", href: INFRA_HREF.access, current: props.current === "access" },
      ]}
    />
  );
}
