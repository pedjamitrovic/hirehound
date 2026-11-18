import { mkdir } from "node:fs/promises";
import { type BrowserContext, chromium, type Frame, type Page } from "playwright-core";
import type { FormField } from "../../shared/schemas/api.ts";
import { CAPTCHA_SELECTOR } from "./form.ts";
import { markFilled, scanFrame } from "./page-scan.js";

type Channel = "chrome" | "msedge";

export class BrowserError extends Error {
  readonly code: "no-browser" | "not-open" | "failed";
  constructor(code: BrowserError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** One instruction for the page. Never a click on a submit button: there is no such action. */
export type FillAction =
  | { id: string; kind: "fill"; value: string }
  | { id: string; kind: "choose"; value: string }
  | { id: string; kind: "check"; checked: boolean }
  | { id: string; kind: "upload"; file: { name: string; data: Buffer } };

export type FillResult = { id: string; ok: boolean; error?: string };

export type PageSnapshot = { url: string; title: string; text: string; png: Buffer };

/**
 * The visible browser for assisted apply: the installed Chrome or Edge with a profile that belongs
 * to Hirehound (you sign in to job sites there once; your own browser profile is never touched).
 * One tab per job. It reads and fills forms; it never submits them and never touches CAPTCHAs.
 */
export class ApplyBrowser {
  readonly #profileDir: string;
  readonly #headless: boolean;
  readonly #channels: Channel[];
  #context: Promise<BrowserContext> | null = null;
  #pages = new Map<string, Page>();

  constructor(options: { profileDir: string; headless?: boolean; channels?: Channel[] }) {
    this.#profileDir = options.profileDir;
    this.#headless = options.headless ?? false;
    this.#channels =
      options.channels ??
      (process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"]);
  }

  async #launch(): Promise<BrowserContext> {
    await mkdir(this.#profileDir, { recursive: true });
    const failures: string[] = [];
    for (const channel of this.#channels) {
      try {
        const context = await chromium.launchPersistentContext(this.#profileDir, {
          channel,
          headless: this.#headless,
          viewport: null,
          acceptDownloads: false,
        });
        context.on("close", () => {
          this.#context = null;
          this.#pages.clear();
        });
        return context;
      } catch (error) {
        failures.push(`${channel}: ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    throw new BrowserError(
      "no-browser",
      `Assisted apply needs Google Chrome or Microsoft Edge, and it could not start one. Close other windows using the Hirehound browser profile and try again. (${failures.join("; ")})`,
    );
  }

  #get(): Promise<BrowserContext> {
    this.#context ??= this.#launch().catch((error: unknown) => {
      this.#context = null;
      throw error;
    });
    return this.#context;
  }

  page(jobId: string): Page | undefined {
    const page = this.#pages.get(jobId);
    if (page?.isClosed()) {
      this.#pages.delete(jobId);
      return undefined;
    }
    return page;
  }

  #require(jobId: string): Page {
    const page = this.page(jobId);
    if (!page) {
      throw new BrowserError(
        "not-open",
        "The application page is not open. Open it in the browser first.",
      );
    }
    return page;
  }

  /** Opens (or reuses) the job's tab at `url` and brings it to the front. */
  async open(jobId: string, url: string): Promise<{ url: string; title: string }> {
    const context = await this.#get();
    let page = this.page(jobId);
    if (!page) {
      // The first window of a persistent profile starts with a blank tab: use it.
      const blank = context
        .pages()
        .find((p) => p.url() === "about:blank" && ![...this.#pages.values()].includes(p));
      page = blank ?? (await context.newPage());
      this.#pages.set(jobId, page);
      page.on("close", () => this.#pages.delete(jobId));
    }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      throw new BrowserError(
        "failed",
        `Could not open ${url}: ${(error as Error).message.split("\n")[0]}`,
      );
    }
    await page.bringToFront().catch(() => {});
    return { url: page.url(), title: await page.title().catch(() => "") };
  }

  async info(jobId: string): Promise<{ url: string; title: string; captcha: boolean } | null> {
    const page = this.page(jobId);
    if (!page) return null;
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      captcha: await this.#hasCaptcha(page),
    };
  }

  async #hasCaptcha(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const found = await frame.$(CAPTCHA_SELECTOR).catch(() => null);
      if (found) return true;
    }
    return false;
  }

  /** Reads every fillable field in every frame of the job's tab. */
  async scan(jobId: string): Promise<{ fields: FormField[]; captcha: boolean }> {
    const page = this.#require(jobId);
    const fields: FormField[] = [];
    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i] as Frame;
      try {
        fields.push(...(await frame.evaluate(scanFrame, `hh${i}-`)));
      } catch {
        // A frame that navigated away or is cross-origin and gone: nothing to fill there.
      }
    }
    return { fields, captcha: await this.#hasCaptcha(page) };
  }

  async #find(page: Page, id: string) {
    for (const frame of page.frames()) {
      const locator = frame.locator(`[data-hirehound-id="${id.replace(/"/g, "")}"]`);
      if ((await locator.count().catch(() => 0)) > 0) return { frame, locator: locator.first() };
    }
    return null;
  }

  /** Fills fields one by one; a field that fails does not stop the others. */
  async fill(jobId: string, actions: FillAction[]): Promise<FillResult[]> {
    const page = this.#require(jobId);
    const results: FillResult[] = [];
    const filled = new Map<Frame, string[]>();
    for (const action of actions) {
      const found = await this.#find(page, action.id);
      if (!found) {
        results.push({ id: action.id, ok: false, error: "The field is no longer on the page." });
        continue;
      }
      const { frame, locator } = found;
      try {
        if (action.kind === "fill") await locator.fill(action.value, { timeout: 5000 });
        else if (action.kind === "choose") {
          const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
          if (tag === "select") {
            await locator
              .selectOption({ label: action.value }, { timeout: 5000 })
              .catch(() => locator.selectOption(action.value, { timeout: 5000 }));
          } else await locator.check({ timeout: 5000 });
        } else if (action.kind === "check")
          await locator.setChecked(action.checked, { timeout: 5000 });
        else {
          await locator.setInputFiles(
            { name: action.file.name, mimeType: "application/pdf", buffer: action.file.data },
            { timeout: 10_000 },
          );
        }
        results.push({ id: action.id, ok: true });
        filled.set(frame, [...(filled.get(frame) ?? []), action.id]);
      } catch (error) {
        results.push({ id: action.id, ok: false, error: (error as Error).message.split("\n")[0] });
      }
    }
    for (const [frame, ids] of filled) await frame.evaluate(markFilled, ids).catch(() => {});
    return results;
  }

  /** The page as it is now: for the confirmation record after you submitted. */
  async snapshot(jobId: string): Promise<PageSnapshot> {
    const page = this.#require(jobId);
    const text = await page
      .evaluate("document.body ? document.body.innerText : ''")
      .then((t) => String(t).slice(0, 20_000))
      .catch(() => "");
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      text,
      png: await page.screenshot({ fullPage: false }),
    };
  }

  async closeJob(jobId: string): Promise<void> {
    await this.page(jobId)
      ?.close()
      .catch(() => {});
    this.#pages.delete(jobId);
  }

  async close(): Promise<void> {
    const current = this.#context;
    this.#context = null;
    this.#pages.clear();
    if (current) await (await current.catch(() => null))?.close().catch(() => {});
  }
}
