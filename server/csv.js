// Minimal, dependency-free CSV parser.
// Handles quoted fields, embedded commas/newlines, and "" escaped quotes.
// Returns an array of row objects keyed by the header row.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  function endField() {
    record.push(field);
    field = '';
  }
  function endRecord() {
    endField();
    // Ignore blank trailing lines.
    if (record.length === 1 && record[0] === '') {
      record = [];
      return;
    }
    rows.push(record);
    record = [];
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush last field/record.
  if (field !== '' || record.length) endRecord();

  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = rows[r][c] !== undefined ? rows[r][c] : '';
    }
    out.push(obj);
  }
  return out;
}
