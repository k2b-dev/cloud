import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Bar, type NavProps, Notice, Pane, Text } from "@k2b/ui/v2";

/** Maintenance mode when its state cannot be read or is not allowed: the frame, and why. */
export default function MaintenanceUnavailable(props: { nav: NavProps; title: string; message: string }) {
  return (
    <AdminWorkspace nav={props.nav} head={<Bar start={<Text type="body">{props.title}</Text>} />}>
      <Pane label={props.title}>
        <Notice tone="bad">{props.message}</Notice>
      </Pane>
    </AdminWorkspace>
  );
}
