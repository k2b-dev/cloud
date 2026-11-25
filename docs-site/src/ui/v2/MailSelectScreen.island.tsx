import { MailScreen } from "./mail-screen";

// The inbox in a selection, nothing open (screen "mail-select"). An island, so the boxes choose rows and the status row
// counts them, as in the app.
export default function MailSelectScreen() {
  return <MailScreen open={false} selecting />;
}
