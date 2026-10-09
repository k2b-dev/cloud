import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import CreateItemButton from "./CreateItemButton.island";

type Props = ComponentProps<typeof CreateItemButton> & { locale: string };

/** The create button as a Space page mounts it: an island below the server locale. */
export default function ItemTemplatesFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <CreateItemButton
        spaceId={props.spaceId}
        columns={props.columns}
        tags={props.tags}
        templates={props.templates}
        dateConfig={props.dateConfig}
        variant="chip"
        defaultType={props.defaultType}
      />
    </LocaleProvider>
  );
}
