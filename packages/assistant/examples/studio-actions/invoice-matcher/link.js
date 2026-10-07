export default async ({ transactionKey, invoicePath }) => {
  const invoice = await cloud.files.read(invoicePath);
  if (!invoice) throw new Error("Copy the selected invoice into this App first.");
  const data = await cloud.db.query("SELECT invoice_path FROM invoice_links WHERE transaction_key = ?", [transactionKey]);
  if (data.length) {
    if (data[0].invoice_path !== invoicePath)
      throw new Error("This transaction is linked to another invoice. Ask the user before changing it.");
    return { linked: true, unchanged: true };
  }
  // One durable link per transaction; concurrent disagreement cannot overwrite it.
  await cloud.db.insert("invoice_links", { transaction_key: transactionKey, invoice_path: invoicePath });
  return { linked: true, unchanged: false };
};
