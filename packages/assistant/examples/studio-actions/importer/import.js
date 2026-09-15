export default async ({ items }) => {
  const db = await database.connect();
  let inserted = 0;
  let skipped = 0;
  // The unique external_key also protects against concurrent imports.
  // A conflicting insert fails; inspect before retrying the remaining items.
  for (const item of items) {
    const { data } = await db.query("SELECT payload FROM records WHERE external_key = ?", [item.key]);
    if (data.length) {
      if (data[0].payload !== item.value) throw new Error(`Existing item changed: ${item.key}`);
      skipped++;
      continue;
    }
    await db.table("records").insert({ external_key: item.key, payload: item.value });
    inserted++;
  }
  return { inserted, skipped };
};
