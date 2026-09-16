import ExcelJS from "exceljs";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const xlsxExtractor: Extractor = {
  id: "xlsx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  async extract({ bytes }) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const sections: string[] = [];
    workbook.eachSheet((sheet) => {
      const lines: string[] = [`# ${sheet.name}`];
      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.text ?? ""));
        lines.push(cells.join("\t"));
      });
      sections.push(lines.join("\n"));
    });
    return { text: normalizeText(sections.join("\n\n")) };
  },
};
