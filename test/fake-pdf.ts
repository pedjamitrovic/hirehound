import { PdfRenderer } from "../src/server/pdf/render.ts";

/**
 * Renders a tiny but real PDF (one page, Helvetica, one line of text per block) from the CV HTML,
 * so tests exercise the PDF hash, the page count and the ATS text round trip without a browser.
 */
export class FakePdfRenderer extends PdfRenderer {
  renders = 0;

  override async render(html: string): Promise<{ pdf: Buffer; pages: number }> {
    this.renders += 1;
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<title[\s\S]*?<\/title>/g, "")
      .replace(/<(?:\/p|\/li|\/h\d|br)[^>]*>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const lines = text
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const content = lines
      .map(
        (line, i) =>
          `BT /F1 10 Tf 40 ${800 - i * 12} Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`,
      )
      .join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    objects.forEach((body, i) => {
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    pdf += "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
    return { pdf: Buffer.from(pdf, "latin1"), pages: 1 };
  }

  override async browserName(): Promise<string> {
    return "Fake PDF renderer";
  }

  override async close(): Promise<void> {}
}
