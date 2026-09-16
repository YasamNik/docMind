export type ExtractInput = { bytes: Uint8Array; mimeType: string; filename: string };
export type ExtractResult = { text: string; note?: string };
export type ExtractorContext = { ocrLanguages: string; dataDir: string };
export type Extractor = {
  id: string;
  mimeTypes: string[];
  extract(input: ExtractInput, ctx: ExtractorContext): Promise<ExtractResult>;
};
