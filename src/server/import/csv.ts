// RFC 4180 CSV parsing, lenient where real exports are sloppy: a quote inside an unquoted field
// is kept as text and an unterminated quoted field runs to the end of the input.
import { normalizeText } from "../../shared/frontmatter.ts";

/**
 * Rows of fields. Line endings become LF everywhere, including inside quoted fields. A final
 * line break does not start an extra row; blank lines elsewhere are rows with one empty field.
 */
export function parseCsv(text: string): string[][] {
  const source = normalizeText(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;

  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (source.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (row.length > 0 || !fieldStart) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
