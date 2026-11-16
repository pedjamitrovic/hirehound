import { signal } from "@preact/signals";

export type Toast = {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  action?: { label: string; run: () => void };
};

export const toasts = signal<Toast[]>([]);

let nextId = 1;

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function toast(
  message: string,
  kind: Toast["kind"] = "info",
  action?: Toast["action"],
): void {
  const id = nextId++;
  toasts.value = [...toasts.value.slice(-3), { id, kind, message, ...(action ? { action } : {}) }];
  setTimeout(() => dismissToast(id), kind === "error" ? 8000 : 4000);
}
