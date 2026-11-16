import { useEffect, useRef } from "preact/hooks";

export type Hotkey = {
  /** "j", "shift+a", "?", "mod+k", "enter", "[", or a sequence like "g t". */
  keys: string;
  description: string;
  /** Heading in the shortcut sheet. */
  group: string;
  run: (event: KeyboardEvent) => void;
  /** Fire even while typing in a text field (use for mod+ combos only). */
  allowInInputs?: boolean;
  /** Not listed in the shortcut sheet. */
  hidden?: boolean;
  /** Return false to make the binding inactive right now. */
  enabled?: () => boolean;
};

type Layer = { get: () => Hotkey[] };

const layers: Layer[] = [];
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(target.type);
  }
  return false;
}

/** Canonical name for a key press: "mod+k", "shift+a", "?", "arrowdown". */
export function comboFromEvent(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // Shift only matters for letters and named keys; "?" already implies shift.
  if (event.shiftKey && (/^[a-z]$/.test(key) || key.length > 1)) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function bindings(): Hotkey[] {
  const all: Hotkey[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const hotkey of layers[i]?.get() ?? []) {
      if (hotkey.enabled?.() ?? true) all.push(hotkey);
    }
  }
  return all;
}

/** All active bindings, top layer first, for the shortcut sheet. */
export function activeHotkeys(): Hotkey[] {
  const seen = new Set<string>();
  return bindings().filter((h) => {
    if (h.hidden || seen.has(h.keys)) return false;
    seen.add(h.keys);
    return true;
  });
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  // Modal dialogs own the keyboard while open.
  if (document.querySelector("dialog[open]")) return;
  const editing = isEditable(event.target);
  const combo = comboFromEvent(event);
  const candidates = bindings().filter((h) => !editing || h.allowInInputs);

  if (pending) {
    const sequence = `${pending} ${combo}`;
    pending = null;
    clearTimeout(pendingTimer);
    const match = candidates.find((h) => h.keys === sequence);
    if (match) {
      event.preventDefault();
      match.run(event);
      return;
    }
  }

  const match = candidates.find((h) => h.keys === combo);
  if (match) {
    event.preventDefault();
    match.run(event);
    return;
  }
  if (candidates.some((h) => h.keys.startsWith(`${combo} `))) {
    pending = combo;
    pendingTimer = setTimeout(() => {
      pending = null;
    }, 1200);
  }
}

if (typeof document !== "undefined") document.addEventListener("keydown", onKeyDown);

/**
 * Registers hotkeys for as long as the component is mounted. Later layers (inner screens) win
 * over earlier ones (the app shell). Handlers always see the latest props via a ref.
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;
  useEffect(() => {
    const layer: Layer = { get: () => ref.current };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, []);
}

/** "mod+k" -> ["Ctrl", "K"] (or the Mac symbol), for <Kbd> rendering. */
export function keyLabels(keys: string): string[][] {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const names: Record<string, string> = {
    mod: mac ? "⌘" : "Ctrl",
    shift: "Shift",
    alt: mac ? "⌥" : "Alt",
    enter: "Enter",
    escape: "Esc",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    space: "Space",
  };
  return keys
    .split(" ")
    .map((step) => step.split("+").map((part) => names[part] ?? part.toUpperCase()));
}
