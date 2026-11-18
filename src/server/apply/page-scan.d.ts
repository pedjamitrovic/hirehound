import type { FormField } from "../../shared/schemas/api.ts";

/** Runs in the page: describes the fillable fields and tags them with data-hirehound-id. */
export function scanFrame(prefix: string): FormField[];

/** Runs in the page: outlines the fields Hirehound filled. */
export function markFilled(ids: string[]): void;
