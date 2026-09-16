import JSZip from "jszip";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export const pptxExtractor: Extractor = {
  id: "pptx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  async extract({ bytes }) {
    const zip = await JSZip.loadAsync(bytes);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
    const sections: string[] = [];
    for (const [i, name] of slideNames.entries()) {
      const xml = await zip.file(name)!.async("string");
      const paragraphs = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((m) =>
        [...m[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join(""),
      );
      sections.push([`# Slide ${i + 1}`, ...paragraphs.filter((p) => p.trim().length > 0)].join("\n"));
    }
    return { text: normalizeText(sections.join("\n\n")) };
  },
};
