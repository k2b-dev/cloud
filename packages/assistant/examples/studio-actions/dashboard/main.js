export default async () => {
  const value = await kv.shared.get("status");
  ui.text({ value: "Operations status" });
  ui.text({ value: value?.message ?? "No status published yet." });
};
