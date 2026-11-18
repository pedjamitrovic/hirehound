import { z } from "zod";
import { AnswersFile } from "../../shared/schemas/answers.ts";
import { Contact } from "../../shared/schemas/contact.ts";
import { CvTheme } from "../../shared/schemas/cv.ts";
import { Preferences } from "../../shared/schemas/preferences.ts";
import type { AppContext } from "../app-context.ts";
import { HANDLED, HttpError, Reply, type Router } from "../http/router.ts";
import { BaseSpec } from "../onboarding/tasks.ts";
import { PdfError } from "../pdf/render.ts";
import { BankOp } from "../profile/bank-ops.ts";
import { PROFILE_FILES } from "../workspace/layout.ts";

const Expected = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
const Save = z.object({ value: z.unknown(), expectedSha256: Expected });
const BaseSave = z.object({ text: z.string().max(200_000), expectedSha256: Expected });
const OpsBody = z.object({ ops: z.array(BankOp).min(1).max(500), expectedSha256: Expected });

/** Generated CV HTML: no scripts, no network, fonts and styles inline. */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; sandbox";

const themeParam = (url: URL) => {
  const theme = url.searchParams.get("theme");
  return theme ? CvTheme.parse(theme) : undefined;
};

export function profileRoutes(router: Router, app: AppContext): void {
  const { profile } = app;

  const yamlFiles = [
    ["contact", PROFILE_FILES.contact, Contact],
    ["preferences", PROFILE_FILES.preferences, Preferences],
    ["answers", PROFILE_FILES.answers, AnswersFile],
  ] as const;
  for (const [name, rel, schema] of yamlFiles) {
    router.get(`/api/profile/${name}`, () => profile.readYaml(rel, schema as z.ZodType));
    router.put(`/api/profile/${name}`, async ({ body }) => {
      const { value, expectedSha256 } = await body(Save);
      return profile.writeYaml(rel, schema as z.ZodType, value, expectedSha256);
    });
  }

  router.get("/api/profile/bank", () => profile.bank());
  router.post("/api/profile/bank/ops", async ({ body }) => {
    const { ops, expectedSha256 } = await body(OpsBody);
    return profile.applyBankOps(ops, expectedSha256);
  });

  router.get("/api/profile/bases", () => profile.listBases());
  router.post("/api/profile/bases/draft", async ({ body }) => {
    const spec = await body(BaseSpec);
    return new Reply(202, app.onboarding.startDraftBase(spec));
  });
  router.get("/api/profile/bases/:id", ({ params }) => profile.readBase(params.id ?? ""));
  router.put("/api/profile/bases/:id", async ({ params, body }) => {
    const { text, expectedSha256 } = await body(BaseSave);
    return profile.writeBase(params.id ?? "", text, expectedSha256);
  });
  router.delete("/api/profile/bases/:id", async ({ params }) => {
    await profile.deleteBase(params.id ?? "");
    return undefined;
  });

  router.get("/api/profile/bases/:id/preview", async ({ params, url, res }) => {
    const html = await profile.baseHtml(params.id ?? "", themeParam(url));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PREVIEW_CSP,
      "cache-control": "no-store",
    });
    res.end(html);
    return HANDLED;
  });

  router.get("/api/profile/bases/:id/pdf", async ({ params, url, res }) => {
    try {
      const id = params.id ?? "";
      const { pdf, pages } = await profile.basePdf(id, themeParam(url));
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": pdf.byteLength,
        "content-disposition": `inline; filename="${id}.pdf"`,
        "cache-control": "no-store",
        "x-pdf-pages": String(pages),
      });
      res.end(pdf);
      return HANDLED;
    } catch (error) {
      if (error instanceof PdfError) throw new HttpError(503, error.code, error.message);
      throw error;
    }
  });

  router.get("/api/profile/imports", () => profile.listImports());
  router.post("/api/profile/imports", async ({ url, raw }) => {
    const name = url.searchParams.get("name") ?? "";
    if (!name.trim()) throw new HttpError(400, "name-required", "The file name is missing");
    const data = await raw(25_000_000);
    return new Reply(201, await profile.addImport(name, data));
  });
  router.delete("/api/profile/imports/:name", async ({ params }) => {
    await profile.deleteImport(params.name ?? "");
    return undefined;
  });
}
