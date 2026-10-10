import { dashboardSettingsService } from "./settings";

export {
  adoptMigratedBoard,
  type DashboardSettingsResult,
  dashboardSettingsService,
  getUserSettings,
  saveUserSettings,
} from "./settings";

export const dashboardService = {
  settings: dashboardSettingsService,
};
