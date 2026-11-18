// Runs inside each frame of an application page: Playwright serialises the function, so it must not
// use anything from outside its body. Plain JavaScript, because the server's TypeScript config has
// no DOM types; page-scan.d.ts describes it.

/**
 * Finds the fields a person would fill in, gives each one a stable `data-hirehound-id` and describes
 * it by its visible label. Radio buttons sharing a name become one field whose options point at the
 * individual buttons.
 * @param {string} prefix
 */
export function scanFrame(prefix) {
  const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el?.textContent);
  let counter = 0;
  const idOf = (el) => {
    let id = el.getAttribute("data-hirehound-id");
    if (!id) {
      id = `${prefix}${counter++}`;
      while (document.querySelector(`[data-hirehound-id="${id}"]`)) id = `${prefix}${counter++}`;
      el.setAttribute("data-hirehound-id", id);
    }
    return id;
  };
  const labelOf = (el) => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((ref) => textOf(document.getElementById(ref)))
        .join(" ");
      if (clean(text)) return clean(text);
    }
    if (clean(el.getAttribute("aria-label"))) return clean(el.getAttribute("aria-label"));
    const own = el.labels?.[0];
    if (own && textOf(own)) return textOf(own);
    const wrapping = el.closest("label");
    if (wrapping && textOf(wrapping)) return textOf(wrapping);
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend && textOf(legend)) return textOf(legend);
    // Text right next to the field, within its small container.
    const container = el.closest("div, li, p, td");
    if (container) {
      const text = clean(
        [...container.childNodes]
          .filter((n) => n !== el && !(n.nodeType === 1 && n.contains(el)))
          .map((n) => n.textContent)
          .join(" "),
      );
      if (text && text.length < 200) return text;
    }
    return clean(el.placeholder) || clean(el.getAttribute("name"));
  };
  const visible = (el) => {
    const style = getComputedStyle(el);
    return (
      style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0
    );
  };
  const required = (el) => Boolean(el.required) || el.getAttribute("aria-required") === "true";
  const SKIP = ["hidden", "submit", "button", "reset", "image", "password", "search"];
  const SIMPLE = ["email", "tel", "url", "number", "date", "checkbox", "file"];

  const fields = [];
  const radios = new Map();
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName.toLowerCase();
    const rawType = tag === "input" ? (el.type || "text").toLowerCase() : tag;
    if (SKIP.includes(rawType) || el.disabled || el.readOnly) continue;
    // File inputs often hide behind a styled button; everything else must be visible.
    if (rawType !== "file" && !visible(el)) continue;

    if (rawType === "radio") {
      const group = el.name || idOf(el);
      const optionLabel = labelOf(el);
      let field = radios.get(group);
      if (!field) {
        const fieldset = el.closest("fieldset");
        const box = el.closest("[role=radiogroup]") ?? fieldset ?? el.parentElement?.parentElement;
        field = {
          id: idOf(el),
          type: "radio",
          label:
            textOf(fieldset?.querySelector("legend")) ||
            clean(box?.getAttribute("aria-label")) ||
            textOf(box?.previousElementSibling) ||
            group,
          required: required(el),
          options: [],
          value: "",
        };
        radios.set(group, field);
        fields.push(field);
      }
      field.options.push({ value: el.value, label: optionLabel || el.value, id: idOf(el) });
      if (el.checked) field.value = optionLabel || el.value;
      continue;
    }

    let type = "text";
    if (tag === "select") type = "select";
    else if (tag === "textarea") type = "textarea";
    else if (el.getAttribute("role") === "combobox") type = "combobox";
    else if (SIMPLE.includes(rawType)) type = rawType;
    const field = {
      id: idOf(el),
      type,
      label: labelOf(el),
      required: required(el),
      options: [],
      value: "",
    };
    if (type === "checkbox") field.value = el.checked ? "true" : "";
    else if (type === "file") field.value = el.files?.length ? el.files[0].name : "";
    else if (type === "select") {
      field.options = [...el.options]
        .filter((o) => !o.disabled && clean(o.textContent))
        .map((o) => ({ value: o.value, label: clean(o.textContent) }));
      const chosen = el.selectedOptions[0];
      field.value = chosen?.value ? clean(chosen.textContent) : "";
    } else field.value = clean(el.value);
    fields.push(field);
  }
  return fields;
}

/**
 * Marks fields Hirehound filled with a soft outline, so you can see at a glance what to check.
 * @param {string[]} ids
 */
export function markFilled(ids) {
  for (const id of ids) {
    const el = document.querySelector(`[data-hirehound-id="${id}"]`);
    if (!el) continue;
    el.style.outline = "2px solid #3b5bdb";
    el.style.outlineOffset = "2px";
    el.setAttribute("title", "Filled by Hirehound: check it before you submit");
  }
}
