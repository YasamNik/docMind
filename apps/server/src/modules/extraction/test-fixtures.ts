import ExcelJS from "exceljs";
import JSZip from "jszip";

// A minimal single-page PDF with a Helvetica text object. Byte offsets in the xref table
// are computed from the actual object positions so pdf.js can parse it without warnings.
export function pdfWithText(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];

  let offset = header.length;
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }

  const pad = (n: number) => String(n).padStart(10, "0");
  const xrefStart = offset;
  const xrefLines = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    ...offsets.map((o) => `${pad(o)} 00000 n `),
    "",
  ].join("\n");
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(header + objects.join("") + xrefLines + trailer);
}

export function pdfWithoutText(): Uint8Array {
  return pdfWithText("");
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export async function docxWithParagraphs(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

export async function xlsxWithRows(sheetName: string, rows: (string | number)[][]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export async function pptxWithSlides(slides: string[][]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  slides.forEach((paragraphs, i) => {
    const shapes = paragraphs.map((p) => `<p:sp><p:txBody><a:p><a:r><a:t>${p}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
    zip.file(`ppt/slides/slide${i + 1}.xml`, `${XML_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`);
  });
  return zip.generateAsync({ type: "uint8array" });
}
