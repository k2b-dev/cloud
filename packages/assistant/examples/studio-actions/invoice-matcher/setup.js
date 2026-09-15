export default async () => {
  const db = await database.connect();
  if (!(await db.tables()).some(table => table.name === "invoice_links")) {
    await db.createTable("invoice_links", [
      { name: "transaction_key", type: "text", unique: true, not_null: true },
      { name: "invoice_path", type: "text", not_null: true },
    ]);
  }
};
