import { Shell } from "@k2b/ui/v2";
import { ssr } from "../config";
import { mails } from "../data";
import MailBoard, { type BoardFolder } from "../islands/MailBoard.island";
import ShellBehaviour from "../islands/ShellBehaviour.client";

const boardFolders: BoardFolder[] = [
  { id: "suppliers", label: "Lieferanten", icon: "folder" },
  { id: "invoices", label: "Rechnungen", icon: "folder" },
  { id: "oak", label: "Projekt Eichentisch", icon: "folder" },
  { id: "drafts", label: "Entwürfe", icon: "draft" },
  { id: "archive", label: "Archiv", icon: "archive" },
];

export default ssr(async (c) => {
  c.get("page").title = "Drag and drop – Mail";
  const list = mails.map(({ id, from, subject, time, unread }) => ({ id, from, subject, time, unread }));
  return () => (
    <Shell>
      <ShellBehaviour />
      <MailBoard inbox="Posteingang" mails={list} folders={boardFolders} />
    </Shell>
  );
});
