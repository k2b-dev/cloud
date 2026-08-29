import { useLocale } from "@k2b/ui";
import { pulseMessages } from "../messages";

export const usePulseMessages = () => {
  const locale = useLocale();
  return () => pulseMessages.resolve([locale()]).t;
};
