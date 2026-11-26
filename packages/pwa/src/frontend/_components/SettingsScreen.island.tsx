import { useLocale } from "@k2b/ui";
import { Bar, Pane, Text, Workspace } from "@k2b/ui/v2";
import { shellMessages } from "../../messages";
import PhoneSettings, { type PhoneSettingsProps } from "./PhoneSettings";

/**
 * Settings of the installable app on v2. The page is bare: its own workspace with "Einstellungen" in the head, so the
 * settings below have its toasts and its questions.
 */
export default function SettingsScreen(props: PhoneSettingsProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  return (
    <Workspace head={<Bar start={<Text type="lead">{t().settings}</Text>} />}>
      <Pane label={t().settings}>
        <PhoneSettings {...props} />
      </Pane>
    </Workspace>
  );
}
