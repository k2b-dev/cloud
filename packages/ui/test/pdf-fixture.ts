/**
 * A small, valid PDF built in memory: `pages` A4 pages, each with "Page N" and a few lines of Helvetica text. Every
 * `landscapeEvery`-th page is landscape, so tests can mix page widths.
 */
export const pdfFixture = (pages: number, landscapeEvery = 0): Uint8Array => {
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let index = 0; index < pages; index++) {
    const landscape = landscapeEvery > 0 && (index + 1) % landscapeEvery === 0;
    const [width, height] = landscape ? [842, 595] : [595, 842];
    const lines = [`BT /F1 32 Tf 72 ${height - 100} Td (Page ${index + 1}) Tj ET`];
    for (let line = 0; line < 6; line++)
      lines.push(`BT /F1 12 Tf 72 ${height - 160 - line * 18} Td (Line ${line + 1} of page ${index + 1}) Tj ET`);
    const stream = lines.join("\n");
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
};
