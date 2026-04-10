import pdfParse from "pdf-parse";

/**
 * Extracts text from a PDF buffer.
 * Throws if no text layer is found (scanned PDFs).
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  const text = result.text.trim();

  if (!text) {
    throw new PdfNoTextError();
  }

  return text;
}

export class PdfNoTextError extends Error {
  constructor() {
    super(
      "Файл не содержит распознаваемого текста. Пожалуйста, загрузите текстовый PDF."
    );
    this.name = "PdfNoTextError";
  }
}
