import type { ApplyMethod, JobState, StatusEvent, StatusFile } from "./schemas/status.ts";

/** The main pipeline, in order. Board columns follow this. */
export const PIPELINE = [
  "found",
  "evaluated",
  "tailoring",
  "ready",
  "approved",
  "applied",
  "screening",
  "interviewing",
  "offer",
] as const satisfies readonly JobState[];

export const CLOSED_STATES = [
  "accepted",
  "rejected",
  "withdrawn",
  "skipped",
  "expired",
] as const satisfies readonly JobState[];

/** States before an application is sent. */
export const PRE_APPLY_STATES = [
  "found",
  "evaluated",
  "tailoring",
  "ready",
  "approved",
] as const satisfies readonly JobState[];

/** Closed states a job can be reopened from. `accepted` is final. */
const REOPENABLE: readonly JobState[] = ["rejected", "withdrawn", "skipped", "expired"];

export const STATE_LABELS: Record<JobState, string> = {
  found: "Found",
  evaluated: "Evaluated",
  tailoring: "Tailoring",
  ready: "Ready",
  approved: "Approved",
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  skipped: "Skipped",
  expired: "Expired",
};

const EDGES: Record<JobState, readonly JobState[]> = {
  found: ["evaluated", "skipped", "expired"],
  evaluated: ["tailoring", "found", "skipped", "expired"],
  tailoring: ["ready", "evaluated", "skipped", "expired"],
  ready: ["approved", "tailoring", "skipped", "expired"],
  approved: ["applied", "ready", "skipped", "expired"],
  applied: ["screening", "interviewing", "offer", "rejected", "withdrawn"],
  screening: ["interviewing", "offer", "rejected", "withdrawn"],
  interviewing: ["offer", "rejected", "withdrawn"],
  offer: ["accepted", "rejected", "withdrawn"],
  accepted: [],
  rejected: [],
  withdrawn: [],
  skipped: [],
  expired: [],
};

export function isClosed(state: JobState): boolean {
  return (CLOSED_STATES as readonly JobState[]).includes(state);
}

export function isPreApply(state: JobState): boolean {
  return (PRE_APPLY_STATES as readonly JobState[]).includes(state);
}

/** Facts about the job's files that guards depend on. Supplied by the server. */
export type GuardContext = {
  /** Tailored CV passes deterministic checks and the verifier found no unsupported claims. */
  cvVerified: boolean;
  /** SHA-256 of the current cv.pdf, or null if there is none. */
  cvPdfSha256: string | null;
};

export const NO_CV: GuardContext = { cvVerified: false, cvPdfSha256: null };

export type TransitionRequest = {
  to: JobState;
  /** Only "external" is meaningful here: an application made outside Hirehound. */
  method?: Extract<ApplyMethod, "external">;
  reason?: string;
};

export type TransitionKind = "edge" | "reopen" | "external";

export type TransitionCheck =
  | { ok: true; kind: TransitionKind }
  | { ok: false; code: "not-allowed" | "guard" | "reason-required"; message: string };

type StatusLike = Pick<StatusFile, "state" | "history" | "approval">;

/** Where "reopen" goes: the most recent non-closed state in the history. */
export function reopenTarget(history: readonly StatusEvent[]): JobState {
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i];
    if (event && !isClosed(event.to)) return event.to;
  }
  return "found";
}

/** Whether a move needs a written reason (captured for calibration and the record). */
export function requiresReason(to: JobState, method?: TransitionRequest["method"]): boolean {
  return to === "skipped" || to === "withdrawn" || method === "external";
}

function guardFailure(status: StatusLike, to: JobState, ctx: GuardContext): string | null {
  if (to === "ready" && !ctx.cvVerified) {
    return "Needs a tailored CV that passes the deterministic checks and the faithfulness verifier.";
  }
  if (to === "approved" && ctx.cvPdfSha256 === null) {
    return "Approve from the CV review screen, which records the SHA-256 of the exact PDF.";
  }
  if (to === "applied") {
    if (!status.approval) {
      return "Needs an approved CV. To record an application made outside Hirehound, use Applied externally.";
    }
    if (ctx.cvPdfSha256 !== status.approval.cv_sha256) {
      return "cv.pdf changed after it was approved. Review and approve it again.";
    }
  }
  return null;
}

export function checkTransition(
  status: StatusLike,
  req: TransitionRequest,
  ctx: GuardContext,
): TransitionCheck {
  const from = status.state;
  if (req.to === from) {
    return { ok: false, code: "not-allowed", message: `Already ${STATE_LABELS[from]}.` };
  }

  let kind: TransitionKind;
  if (req.method === "external") {
    if (req.to !== "applied" || !isPreApply(from)) {
      return {
        ok: false,
        code: "not-allowed",
        message: "Applied externally is only possible before an application is recorded.",
      };
    }
    kind = "external";
  } else if (REOPENABLE.includes(from)) {
    const target = reopenTarget(status.history);
    if (req.to !== target) {
      return {
        ok: false,
        code: "not-allowed",
        message: `${STATE_LABELS[from]} jobs can only be reopened to ${STATE_LABELS[target]}.`,
      };
    }
    kind = "reopen";
  } else {
    if (!EDGES[from].includes(req.to)) {
      return {
        ok: false,
        code: "not-allowed",
        message: `Cannot move from ${STATE_LABELS[from]} to ${STATE_LABELS[req.to]}.`,
      };
    }
    const failure = guardFailure(status, req.to, ctx);
    if (failure) return { ok: false, code: "guard", message: failure };
    kind = "edge";
  }

  if (requiresReason(req.to, req.method) && !req.reason?.trim()) {
    return { ok: false, code: "reason-required", message: "Please add a short reason." };
  }
  return { ok: true, kind };
}

export type TransitionOption = {
  to: JobState;
  kind: TransitionKind;
  method?: "external";
  allowed: boolean;
  /** Why it is not allowed (guard message). */
  message?: string;
  needsReason: boolean;
};

/** Every move the UI should offer from the current state, including blocked ones with the reason. */
export function transitionOptions(status: StatusLike, ctx: GuardContext): TransitionOption[] {
  const from = status.state;
  const options: TransitionOption[] = [];

  if (REOPENABLE.includes(from)) {
    options.push({
      to: reopenTarget(status.history),
      kind: "reopen",
      allowed: true,
      needsReason: false,
    });
    return options;
  }

  for (const to of EDGES[from]) {
    const failure = guardFailure(status, to, ctx);
    options.push({
      to,
      kind: "edge",
      allowed: failure === null,
      ...(failure ? { message: failure } : {}),
      needsReason: requiresReason(to),
    });
  }
  if (isPreApply(from)) {
    options.push({
      to: "applied",
      kind: "external",
      method: "external",
      allowed: true,
      needsReason: true,
    });
  }
  return options;
}

/** Returns a new status with the transition applied. Call checkTransition first. */
export function applyTransition<T extends StatusFile>(
  status: T,
  req: TransitionRequest,
  meta: { at: string; by: StatusEvent["by"] },
): T {
  const event: StatusEvent = {
    at: meta.at,
    from: status.state,
    to: req.to,
    by: meta.by,
    ...(req.reason?.trim() ? { reason: req.reason.trim() } : {}),
  };
  const next: T = { ...status, state: req.to, history: [...status.history, event] };
  if (req.method === "external") {
    next.application = { at: meta.at, method: "external" };
  }
  // Revoking an approval (approved -> ready) removes it; the history keeps the record.
  if (status.state === "approved" && req.to === "ready") delete next.approval;
  return next;
}

/** Board navigation: the next or previous pipeline state, if that move is an allowed edge. */
export function neighbourInPipeline(
  status: StatusLike,
  direction: 1 | -1,
  ctx: GuardContext,
): JobState | null {
  const index = (PIPELINE as readonly JobState[]).indexOf(status.state);
  if (index < 0) return null;
  const target = PIPELINE[index + direction];
  if (!target) return null;
  return checkTransition(status, { to: target }, ctx).ok ? target : null;
}
