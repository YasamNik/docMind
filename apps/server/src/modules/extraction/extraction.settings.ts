import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";

export const extractionSettingDefinitions = [
  defineSetting({
    key: "extraction.ocrLanguages",
    schema: v.pipe(v.string(), v.regex(/^[a-z_]{3,}(\+[a-z_]{3,})*$/, "Use tesseract language codes joined with +, for example eng or eng+deu")),
    env: "OCR_LANGUAGES",
    default: "eng",
    doc: "Tesseract language codes for image OCR, joined with +. Language data downloads on first use.",
  }),
  defineSetting({
    key: "extraction.dataDir",
    schema: v.pipe(v.string(), v.minLength(1)),
    env: "DATA_DIR",
    default: "./data",
    doc: "Directory for downloaded OCR language data and other caches.",
  }),
];
