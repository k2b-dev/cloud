import { clipboard } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import { useToast } from "@k2b/ui/v2";
import { toolsWorkspaceMessages } from "./tools-messages";

/** Copies a tool's result and says so in a toast ("Kopiert", or "Nicht kopiert" when the browser refused). */
export const useToolCopy = () => {
  const locale = useLocale();
  const toast = useToast();
  return async (text: string) => {
    const t = toolsWorkspaceMessages.resolve([locale()]).t;
    try {
      await clipboard.copy(text);
      toast(t.copied, { status: "ok" });
    } catch {
      toast(t.notCopied, { status: "bad" });
    }
  };
};
