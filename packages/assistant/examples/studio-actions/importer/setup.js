export default async () => {
  const db = await database.connect();
  if (!(await db.tables()).some((table) => table.name === "records")) {
    await db.createTable("records", [
      { name: "external_key", type: "text", unique: true, not_null: true },
      { name: "payload", type: "text", not_null: true },
    ]);
  }
};
