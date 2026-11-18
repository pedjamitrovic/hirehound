import { type Browser, chromium } from "playwright-core";
import type { Paper } from "./document.ts";

export class PdfError extends Error {
  readonly code: "no-browser" | "render-failed";
  constructor(code: PdfError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Pages in a PDF produced by Chrome: count page objects (not the /Pages tree nodes). */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

type Channel = "chrome" | "msedge";

/**
 * Renders HTML to PDF with the Chrome or Edge already installed on this computer (playwright-core
 * downloads nothing). The browser starts on first use and is reused; renders are serialised.
 */
export class PdfRenderer {
  #browser: Promise<{ browser: Browser; channel: Channel }> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #channels: Channel[];

  constructor(options: { channels?: Channel[] } = {}) {
    const preferred = process.env.HIREHOUND_BROWSER;
    const defaults: Channel[] =
      process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
    this.#channels =
      options.channels ??
      (preferred === "chrome" || preferred === "msedge"
        ? [preferred, ...defaults.filter((c) => c !== preferred)]
        : defaults);
  }

  async #launch(): Promise<{ browser: Browser; channel: Channel }> {
    const failures: string[] = [];
    for (const channel of this.#channels) {
      try {
        const browser = await chromium.launch({ channel, headless: true });
        browser.on("disconnected", () => {
          this.#browser = null;
        });
        return { browser, channel };
      } catch (error) {
        failures.push(`${channel}: ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    // Playwright says "is not found" when a channel is not installed; anything else is a failed start.
    const missing = failures.every((f) => /not found/i.test(f));
    throw new PdfError(
      "no-browser",
      missing
        ? `PDF rendering needs Google Chrome or Microsoft Edge installed. (${failures.join("; ")})`
        : `Chrome or Edge is installed but did not start. (${failures.join("; ")})`,
    );
  }

  async #get(): Promise<{ browser: Browser; channel: Channel }> {
    this.#browser ??= this.#launch().catch((error: unknown) => {
      this.#browser = null;
      throw error;
    });
    return this.#browser;
  }

  async browserName(): Promise<string> {
    const { browser, channel } = await this.#get();
    return `${channel === "msedge" ? "Microsoft Edge" : "Google Chrome"} ${browser.version()}`;
  }

  render(html: string, paper: Paper): Promise<{ pdf: Buffer; pages: number }> {
    const job = this.#queue.then(async () => {
      const { browser } = await this.#get();
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluateHandle("document.fonts.ready").catch(() => {});
        const pdf = await page.pdf({
          format: paper === "letter" ? "Letter" : "A4",
          printBackground: true,
          preferCSSPageSize: true,
          tagged: true,
        });
        return { pdf, pages: countPdfPages(pdf) };
      } catch (error) {
        if (error instanceof PdfError) throw error;
        throw new PdfError(
          "render-failed",
          `PDF rendering failed: ${(error as Error).message.split("\n")[0]}`,
        );
      } finally {
        await context.close().catch(() => {});
      }
    });
    this.#queue = job.catch(() => {});
    return job;
  }

  async close(): Promise<void> {
    const current = this.#browser;
    this.#browser = null;
    if (current) await (await current.catch(() => null))?.browser.close();
  }
}
