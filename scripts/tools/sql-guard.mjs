// sb-query's read-only mode runs as supabase_read_only_user in a read-only transaction, but that transaction can switch
// itself to read-write ("set transaction read write", "commit; begin read write", a DO body that commits): measured
// 2026-10-22, review round 2. readOnlyEscape(sql) names the first such statement, or null. It stops careless SQL, not
// a determined author (EXECUTE of a built string gets past it); the database grants are the real boundary.

// Splits SQL into top-level code (comments dropped, string literals and dollar-quoted bodies blanked) and the bodies.
// As Postgres reads it: block comments nest, and an E'...' escape string takes backslash escapes (review round 3: out of
// step, the scanner took a later statement for part of a string).
function scan(sql) {
  let code = "", i = 0;
  const bodies = [];
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === "--") { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j; continue; }
    if (two === "/*") {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) { depth++; j += 2; } else if (sql.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
      i = j; code += " "; continue;
    }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[e]$/i.test(code) && !/[a-z0-9_$]$/i.test(code.slice(0, -1));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      i = j + 1; code += ` ${c}${c} `; continue;
    }
    // As Postgres: a `$` inside an identifier (a$x$) opens no dollar-quote (review round 4).
    // Tags may hold non-ASCII letters, as Postgres allows ($é$, review round 5).
    const tag = c === "$" && !/[a-z0-9_$\u0080-￿]/i.test(sql[i - 1] || "")
      && /^\$([a-z_\u0080-￿][a-z0-9_\u0080-￿]*)?\$/i.exec(sql.slice(i));
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
// Session settings that cannot change the transaction's read-only mode (review round 3: these were refused too).
const SAFE_SETTING = /^(set\s+(session\s+|local\s+)?|reset\s+)(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|search_path|time\s*zone|work_mem|client_min_messages|application_name|extra_float_digits|datestyle|intervalstyle)\b/;

export function readOnlyEscape(sql) {
  const lower = String(sql || "").toLowerCase();
  const { code, bodies } = scan(lower);
  for (const c of [code, ...bodies.map(b => scan(b).code)]) {
    const m = c.match(IN_CODE);
    if (m) return m[0].replace(/\s+/g, " ");
  }
  for (const s of code.split(";")) {
    const m = s.trim().match(STATEMENT);
    if (m && !SAFE_SETTING.test(s.trim())) return m[0];
  }
  for (const b of bodies) {
    const m = scan(b).code.match(/\b(commit|rollback)\b/);
    if (m) return m[0] + " (in a DO body)";
  }
  return null;
}
