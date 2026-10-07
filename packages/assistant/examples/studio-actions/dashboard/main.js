export default async () => {
  const value = await cloud.kv.get("status");
  ui.text({ value: "Operations status" });
  ui.text({ value: value?.message ?? "No status published yet." });
};
