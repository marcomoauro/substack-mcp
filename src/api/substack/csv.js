/**
 * Minimal RFC-4180-ish CSV reader, enough for what Substack's subscriber export produces.
 *
 * A `split(',')` is not enough and the failure is silent rather than loud: subscriber names and
 * place names contain commas ("Smith, John"), and one of them shifts every later field onto the
 * wrong column for that row only. The export also quotes its currency values, so the quotes have
 * to come off.
 *
 * Deliberately not a dependency: this is ~40 lines against a format the export controls, and the
 * project pins everything exactly and keeps its dependency surface minimal.
 */

/**
 * Parses `text` into `{header, rows}`, both arrays of string cells.
 *
 * Quoted fields may contain commas, newlines and doubled quotes (`""` → `"`). Malformed input
 * degrades rather than throwing — an unterminated quote simply consumes the rest of the input —
 * because a caller inspecting a broken export is better served than one holding an exception.
 */
export function parseCsv(text) {
  if (text.trim() === '') return {header: [], rows: []};

  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = '';
  };

  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // A doubled quote is an escaped quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }

      field += char;
      i += 1;
      continue;
    }

    // A quote only opens a quoted field at the start of one; mid-field it is literal, so `12" pizza`
    // survives intact.
    if (char === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }

    if (char === ',') {
      endField();
      i += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      endRecord();
      // Consume the LF of a CRLF pair so it does not open an empty record.
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // Whatever is still buffered is the last record, unless the input ended on a line break and left
  // nothing behind — that trailing newline must not become an empty row.
  if (field !== '' || record.length > 0 || quoted) endRecord();

  const [header = [], ...rows] = records;
  return {header, rows};
}
