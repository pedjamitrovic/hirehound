import type { BankKind } from "../../../shared/schemas/bank.ts";

export type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "list" | "select";
  /** For lists: how values are separated in the text box. */
  separator?: "lines" | "commas";
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: string[];
  wide?: boolean;
};

const START: FieldDef = { key: "start", label: "Start", placeholder: "2021-03" };
const END: FieldDef = { key: "end", label: "End", placeholder: "2023-06 or present" };
const TAGS: FieldDef = { key: "tags", label: "Tags", type: "list", separator: "commas" };

/** The form for each kind of bank entry. Keys match src/shared/schemas/bank.ts. */
export const FIELDS: Record<BankKind, FieldDef[]> = {
  role: [
    {
      key: "title",
      label: "Title",
      required: true,
      hint: "Exactly as it was, e.g. Engineering Manager",
    },
    { key: "company", label: "Company", required: true },
    START,
    END,
    { key: "location", label: "Location" },
    {
      key: "employment_type",
      label: "Type",
      type: "select",
      options: ["", "full-time", "part-time", "contract", "freelance", "internship"],
    },
    {
      key: "summary",
      label: "Scope",
      type: "textarea",
      wide: true,
      hint: "One or two factual sentences: team, product, responsibilities.",
    },
    TAGS,
  ],
  achievement: [
    {
      key: "text",
      label: "Claim",
      type: "textarea",
      required: true,
      wide: true,
      hint: "One line, as it could appear on a CV.",
    },
    {
      key: "metrics",
      label: "Figures",
      type: "list",
      separator: "lines",
      hint: "Exactly as stated, one per line, e.g. 4 to 14 engineers",
    },
    { key: "skills", label: "Skills", type: "list", separator: "commas" },
    {
      key: "detail",
      label: "Context",
      type: "textarea",
      wide: true,
      hint: "Scope, how, constraints. Used to verify claims; not printed as is.",
    },
    TAGS,
  ],
  project: [
    { key: "name", label: "Name", required: true },
    { key: "role", label: "Your role" },
    START,
    END,
    { key: "url", label: "Link", placeholder: "https://" },
    { key: "summary", label: "Summary", type: "textarea", wide: true },
    TAGS,
  ],
  education: [
    { key: "institution", label: "Institution", required: true },
    { key: "degree", label: "Degree" },
    { key: "field", label: "Field" },
    { key: "location", label: "Location" },
    START,
    END,
    { key: "detail", label: "Details", type: "textarea", wide: true },
  ],
  certification: [
    { key: "name", label: "Name", required: true },
    { key: "issuer", label: "Issuer" },
    { key: "date", label: "Date", placeholder: "2024-05" },
    { key: "expires", label: "Expires", placeholder: "2027-05" },
    { key: "url", label: "Link", placeholder: "https://", wide: true },
  ],
  skill: [
    { key: "name", label: "Group", required: true, placeholder: "Languages" },
    {
      key: "items",
      label: "Skills",
      type: "list",
      separator: "commas",
      required: true,
      wide: true,
      placeholder: "TypeScript, Go, PostgreSQL",
    },
  ],
  language: [
    { key: "name", label: "Language", required: true },
    { key: "level", label: "Level", placeholder: "Native, C1, Professional" },
  ],
  award: [
    { key: "name", label: "Name", required: true },
    { key: "issuer", label: "Issuer" },
    { key: "date", label: "Date", placeholder: "2022" },
    { key: "detail", label: "Details", type: "textarea", wide: true },
  ],
};

export const KIND_LABELS: Record<BankKind, string> = {
  role: "Role",
  achievement: "Achievement",
  project: "Project",
  education: "Education",
  certification: "Certification",
  skill: "Skill group",
  language: "Language",
  award: "Award",
};

export function toFormValue(field: FieldDef, value: unknown): string {
  if (Array.isArray(value)) return value.join(field.separator === "lines" ? "\n" : ", ");
  return value === undefined || value === null ? "" : String(value);
}

export function fromFormValue(field: FieldDef, text: string): unknown {
  if (field.type === "list") {
    const parts = text.split(field.separator === "lines" ? /\n/ : /[,\n]/);
    const items = parts.map((p) => p.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}
