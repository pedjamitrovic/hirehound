import { effect, signal } from "@preact/signals";

export type Theme = "system" | "light" | "dark";

const KEY = "hirehound.theme";

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export const theme = signal<Theme>(stored());

effect(() => {
  const value = theme.value;
  const root = document.documentElement;
  if (value === "system") delete root.dataset.theme;
  else root.dataset.theme = value;
  try {
    if (value === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts for this session.
  }
});
