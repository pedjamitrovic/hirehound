import { indexBank } from "../../shared/bank.ts";
import type { TaskInfo } from "../../shared/schemas/api.ts";
import type { OnboardingFile } from "../../shared/schemas/onboarding.ts";
import { runTask } from "../ai/run-task.ts";
import type { AiService } from "../ai/service.ts";
import { HttpError } from "../http/router.ts";
import { extractSource } from "../import/extract.ts";
import { appendEntries } from "../profile/bank-ops.ts";
import type { ProfileService } from "../profile/service.ts";
import type { TaskContext, TaskRunner } from "../tasks.ts";
import {
  applyAnswersTask,
  type BaseSpec,
  draftBankTask,
  draftBaseTask,
  draftToEntries,
  proposalToOps,
  type SourceDoc,
} from "./tasks.ts";

type Deps = { profile: ProfileService; ai: AiService; tasks: TaskRunner };

const nextQuestionId = (file: OnboardingFile, offset: number) => {
  const max = file.questions.reduce((m, q) => Math.max(m, Number(q.id.slice(2)) || 0), 0);
  return `Q-${String(max + offset).padStart(3, "0")}`;
};

/**
 * The onboarding flow: imported files -> drafted bank entries and questions -> answers turned into
 * proposed edits -> base CVs. Each AI step runs as a background task with progress over SSE.
 */
export class OnboardingService {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  #track<T>(
    ctx: TaskContext,
    run: () => Promise<{ output: T; usage: Parameters<TaskContext["addUsage"]>[0] }>,
  ) {
    return run().then((result) => {
      ctx.addUsage(result.usage);
      return result.output;
    });
  }

  /** Reads every stored import and drafts new, unconfirmed bank entries plus gap questions. */
  startDraftBank(names?: string[]): TaskInfo {
    const { profile, ai, tasks } = this.#deps;
    return tasks.start(
      "draft-bank",
      "Drafting your experience bank",
      async (ctx) => {
        const imports = (await profile.listImports()).filter(
          (i) => i.error === null && (!names || names.includes(i.name)),
        );
        if (imports.length === 0)
          throw new HttpError(400, "no-imports", "Add at least one file first.");
        ctx.progress(`Reading ${imports.length} file${imports.length === 1 ? "" : "s"}`);
        const sources: SourceDoc[] = [];
        for (const info of imports) {
          const source = extractSource(info.name, await profile.readImport(info.name));
          sources.push({
            name: info.name,
            attachment:
              source.kind === "pdf"
                ? { kind: "pdf", name: info.name, data: source.data }
                : { kind: "text", name: info.name, text: source.text },
          });
        }
        const existing = (await profile.bank()).value;
        const output = await this.#track(ctx, () =>
          runTask(
            ai,
            draftBankTask,
            { sources, existing },
            { root: profile.root, signal: ctx.signal, onProgress: ctx.aiProgress },
          ),
        );

        ctx.progress("Saving the draft");
        let ids = new Map<string, string>();
        await profile.writeBankText((current) => {
          const result = appendEntries(
            current,
            draftToEntries(output, (name) => `imports/${name}`),
          );
          ids = result.ids;
          return result.text;
        });
        const c = output.contact;
        await profile.updateOnboarding((file) => ({
          ...file,
          contact_suggestion: {
            ...(c.name ? { name: c.name } : {}),
            ...(c.email ? { email: c.email } : {}),
            ...(c.phone ? { phone: c.phone } : {}),
            ...(c.location ? { location: c.location } : {}),
            links: c.links,
          },
          questions: [
            ...file.questions,
            ...output.questions.map((q, i) => ({
              id: nextQuestionId(file, i + 1),
              ...(q.about && ids.get(q.about) ? { entry: ids.get(q.about) } : {}),
              question: q.question,
              why: q.why,
              status: "open" as const,
            })),
          ],
        }));
        return { entries: ids.size, questions: output.questions.length };
      },
      { exclusive: true },
    );
  }

  /** Saves answers as the user types them (no AI involved). */
  saveAnswers(
    answers: { id: string; answer?: string | undefined; status?: "open" | "skipped" | undefined }[],
  ) {
    return this.#deps.profile.updateOnboarding((file) => ({
      ...file,
      questions: file.questions.map((q) => {
        const update = answers.find((a) => a.id === q.id);
        if (!update) return q;
        return {
          ...q,
          ...(update.answer !== undefined ? { answer: update.answer } : {}),
          ...(update.status ? { status: update.status } : {}),
        };
      }),
    }));
  }

  /** Turns answered questions into proposed bank edits. Nothing is saved until the user applies them. */
  startProposeAnswers(): TaskInfo {
    const { profile, ai, tasks } = this.#deps;
    return tasks.start(
      "apply-answers",
      "Turning your answers into bank edits",
      async (ctx) => {
        const file = await profile.onboarding();
        const answered = file.questions
          .filter((q) => q.status === "open" && q.answer?.trim())
          .map((q) => ({ id: q.id, entry: q.entry, question: q.question, answer: q.answer ?? "" }));
        if (answered.length === 0)
          throw new HttpError(400, "no-answers", "Answer at least one question first.");
        const bankFile = await profile.bank();
        if (!bankFile.value)
          throw new HttpError(409, "no-bank", "There is no experience bank yet.");
        const output = await this.#track(ctx, () =>
          runTask(
            ai,
            applyAnswersTask,
            { bank: bankFile.value as NonNullable<typeof bankFile.value>, answered },
            { root: profile.root, signal: ctx.signal, onProgress: ctx.aiProgress },
          ),
        );
        const proposal = proposalToOps(bankFile.value, output);
        return {
          ...proposal,
          bankSha256: bankFile.sha256,
          questionIds: answered.map((q) => q.id),
          unused: output.unused,
        };
      },
      { exclusive: true },
    );
  }

  /** Marks questions as applied after the user accepted the proposed edits. */
  resolveQuestions(ids: string[], status: "applied" | "skipped" | "open") {
    return this.#deps.profile.updateOnboarding((file) => ({
      ...file,
      questions: file.questions.map((q) => (ids.includes(q.id) ? { ...q, status } : q)),
    }));
  }

  /** Drafts a base CV from confirmed bank entries and saves it to profile/bases. */
  startDraftBase(spec: BaseSpec): TaskInfo {
    const { profile, ai, tasks } = this.#deps;
    return tasks.start("draft-base", `Writing the "${spec.label}" base CV`, async (ctx) => {
      const bank = (await profile.bank()).value;
      if (!bank) throw new HttpError(409, "no-bank", "Create your experience bank first.");
      const confirmed = [...indexBank(bank).values()].filter((e) => e.entry.confirmed);
      if (confirmed.length === 0) {
        throw new HttpError(
          409,
          "nothing-confirmed",
          "Confirm some experience bank entries first; CVs only use confirmed facts.",
        );
      }
      const contact = (await profile.contact()).value;
      const prefs = (await profile.preferences()).value;
      const output = await this.#track(ctx, () =>
        runTask(
          ai,
          draftBaseTask,
          { spec, bank, name: contact?.name ?? null, maxPages: prefs?.cv.max_pages ?? 2 },
          { root: profile.root, signal: ctx.signal, onProgress: ctx.aiProgress },
        ),
      );
      ctx.progress("Saving the base CV");
      const detail = await profile.createBase(
        spec.label,
        {
          label: spec.label,
          track: spec.track,
          target_titles: spec.target_titles,
          headline: output.headline,
          emphasis: spec.emphasis,
          theme: "classic",
        },
        output.body,
      );
      return { id: detail.summary.id, notes: output.notes };
    });
  }
}
