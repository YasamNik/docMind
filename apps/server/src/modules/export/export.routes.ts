import type { Context, Hono } from "hono";
import type { ExportService } from "./export.usecases.js";

export function registerExportRoutes({
  app,
  exportService,
  getUserId,
}: {
  app: Hono;
  exportService: ExportService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/export", async (c) => {
    const buffer = await exportService.exportAll({ userId: getUserId(c) });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="docmind-export-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Content-Length": String(buffer.length),
      },
    });
  });
}
