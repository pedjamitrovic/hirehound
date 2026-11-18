import { z } from "zod";
import type { AppContext } from "../app-context.ts";
import { HttpError, Reply, type Router } from "../http/router.ts";

const DraftBody = z.object({ names: z.array(z.string()).optional() });
const AnswersBody = z.object({
  answers: z
    .array(
      z.object({
        id: z.string(),
        answer: z.string().max(5000).optional(),
        status: z.enum(["open", "skipped"]).optional(),
      }),
    )
    .max(200),
});
const ResolveBody = z.object({
  ids: z.array(z.string()).min(1),
  status: z.enum(["applied", "skipped", "open"]),
});
const AiUpdate = z.object({
  engine: z.enum(["anthropic-api", "claude-code"]).optional(),
  model: z.string().trim().min(1).max(100).optional(),
});
const KeyBody = z.object({ key: z.string().trim().max(500).nullable() });

export function onboardingRoutes(router: Router, app: AppContext): void {
  router.get("/api/onboarding", () => app.profile.onboarding());
  router.post("/api/onboarding/draft", async ({ body }) => {
    const { names } = await body(DraftBody);
    return new Reply(202, app.onboarding.startDraftBank(names));
  });
  router.put("/api/onboarding/answers", async ({ body }) => {
    const { answers } = await body(AnswersBody);
    return app.onboarding.saveAnswers(answers);
  });
  router.post(
    "/api/onboarding/answers/propose",
    () => new Reply(202, app.onboarding.startProposeAnswers()),
  );
  router.post("/api/onboarding/questions/resolve", async ({ body }) => {
    const { ids, status } = await body(ResolveBody);
    return app.onboarding.resolveQuestions(ids, status);
  });

  router.get("/api/tasks", () => app.tasks.list());
  router.get("/api/tasks/:id", ({ params }) => {
    const task = app.tasks.get(params.id ?? "");
    if (!task) throw new HttpError(404, "task-not-found", "No such task");
    return task;
  });
  router.post("/api/tasks/:id/cancel", ({ params }) => {
    if (!app.tasks.cancel(params.id ?? ""))
      throw new HttpError(404, "task-not-found", "Nothing to cancel");
    return undefined;
  });

  router.get("/api/settings/ai", () => app.ai.settings());
  router.put("/api/settings/ai", async ({ body }) => {
    const patch = await body(AiUpdate);
    return app.ai.update({
      ...(patch.engine ? { engine: patch.engine } : {}),
      ...(patch.model ? { model: patch.model } : {}),
    });
  });
  router.put("/api/settings/ai/key", async ({ body }) => {
    const { key } = await body(KeyBody);
    return app.ai.setApiKey(key);
  });
  router.post("/api/settings/ai/test", () => app.ai.health());
  router.get("/api/settings/pdf", async () => {
    try {
      return { ok: true, detail: await app.pdf.browserName() };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  });
}
