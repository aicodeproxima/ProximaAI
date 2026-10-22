// sb-query's read-only mode runs as supabase_read_only_user in a read-only transaction, but that transaction can switch
// itself to read-write ("set transaction read write", "commit; begin read write", a DO body that commits): measured
// 2026-10-22, review round 2. readOnlyEscape(sql) names the first such statement, or null. It stops careless SQL, not
// a determined author (EXECUTE of a built string gets past it); the database grants are the real boundary.

// Splits SQL into top-level code (comments dropped, string literals and dollar-quoted bodies blanked) and the bodies.
function scan(sql) {
  let code = "", i = 0;
  const bodies = [];
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === "--") { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j; continue; }
    if (two === "/*") { const j = sql.indexOf("*/", i + 2); i = j < 0 ? sql.length : j + 2; code += " "; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      i = j + 1; code += ` ${c}${c} `; continue;
    }
    const tag = c === "$" && /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i));
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      bodies.push(sql.slice(i + tag[0].length, end < 0 ? sql.length : end));
      i = end < 0 ? sql.length : end + tag[0].length; code += " $$ "; continue;
    }
    code += c; i++;
  }
  return { code, bodies };
}

// Searched in code only (top level and DO bodies): changing a setting takes code (SET, set_config(), ALTER ROLE ... SET),
// while reading one names it inside a string (current_setting('transaction_read_only')).
const IN_CODE = /set_config\s*\(|session\s+authorization|session\s+characteristics|\bset\s+(local\s+|session\s+)?(role|transaction)\b|\b(default_)?transaction_read_only\b/;
const STATEMENT = /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare|set|reset|discard)\b/;

export function readOnlyEscape(sql) {
  const lower = String(sql || "").toLowerCase();
  const { code, bodies } = scan(lower);
  for (const c of [code, ...bodies.map(b => scan(b).code)]) {
    const m = c.match(IN_CODE);
    if (m) return m[0].replace(/\s+/g, " ");
  }
  for (const s of code.split(";")) {
    const m = s.trim().match(STATEMENT);
    if (m) return m[0];
  }
  for (const b of bodies) {
    const m = scan(b).code.match(/\b(commit|rollback)\b/);
    if (m) return m[0] + " (in a DO body)";
  }
  return null;
}
