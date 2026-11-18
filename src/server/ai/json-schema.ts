import { z } from "zod";

/** Keywords structured outputs do not support; Zod still enforces them on the result. */
const UNSUPPORTED = new Set([
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "minProperties",
  "maxProperties",
  "propertyNames",
]);

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    if (key === "format" && !SUPPORTED_FORMATS.has(String(value))) continue;
    if (key === "oneOf") {
      out.anyOf = clean(value);
      continue;
    }
    out[key] = clean(value);
  }
  if (out.type === "object" || (out.properties && typeof out.properties === "object")) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * JSON Schema for a Zod output contract, restricted to what structured outputs accept. The model
 * sees the shape; Zod checks every constraint (lengths, patterns, refinements) on the result.
 */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // "input" makes fields with defaults optional, so the model may leave them out.
    io: "input",
    unrepresentable: "any",
  });
  return clean(json) as Record<string, unknown>;
}
