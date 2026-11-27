import PhoneSettings, { type PhoneSettingsProps } from "./PhoneSettings";

/** The content of Settings on v2, inside the app's frame: the frame brings the head and the way back to Start. */
export default function SettingsScreen(props: PhoneSettingsProps) {
  return <PhoneSettings {...props} />;
}
