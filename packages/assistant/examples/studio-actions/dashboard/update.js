export default async ({ message }) => {
  // This action deliberately replaces one complete value; no read/modify/write race.
  await cloud.kv.set("status", { message });
  return { saved: true };
};
