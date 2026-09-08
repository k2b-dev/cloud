export const accountSettingsSection = (key: string): "sign-in" | "registration" =>
  key.startsWith("user.category.") || key.startsWith("user.app_approval.") || key.startsWith("user.session.") ? "sign-in" : "registration";
