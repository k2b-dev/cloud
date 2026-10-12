import { DetailPanel, Switch, useLocale } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../messages";
import { changeFullWidth, createFullWidth } from "../full-width";

/**
 * The detail panel's "Full width" switch. The server renders its state from
 * the cookie; app.css hides it on screens where it would change nothing.
 */
export function FullWidthSection(props: { initial: boolean }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const fullWidth = createFullWidth(props.initial);
  return (
    <DetailPanel.Section class="notebooks-full-width-option" title={t().view} icon="ti ti-layout" tone="neutral">
      <Switch label={t().fullWidth} description={t().fullWidthHint} value={fullWidth} onValueChange={changeFullWidth} />
    </DetailPanel.Section>
  );
}
