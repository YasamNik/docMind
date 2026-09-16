// pdfjs-dist's DocumentInitParameters type does not match the legacy build's accepted
// options at this version, so this module is declared loosely.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export function getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}
