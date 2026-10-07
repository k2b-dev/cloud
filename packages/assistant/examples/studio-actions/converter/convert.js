export default async ({ csv }) => {
  const rows = await cloud.sheet.parseCsv(csv);
  await cloud.download("converted.json", new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
  return { rows: rows.length };
};
