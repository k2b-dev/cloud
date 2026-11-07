import CacheNotice from "../CacheNotice";
import { LegacySettingsSection } from "../settings/_components/LegacySettingsSection";

/** Stored settings no app declares any more, below the general settings as before. */
export default function LegacySettings() {
  return (
    <div class="flex max-w-2xl flex-col gap-4">
      <CacheNotice area="settings" />
      <LegacySettingsSection />
    </div>
  );
}
