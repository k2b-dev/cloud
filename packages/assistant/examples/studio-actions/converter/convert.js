export default async ({ csv }) => {
  const rows = await sheet.fromCsv(csv);
  await files.save(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), "converted.json");
  return { rows: rows.length };
};
