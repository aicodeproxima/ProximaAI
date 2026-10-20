// Safe evaluator for WaveSpeed's pricing formulas: the JSONata subset their model pages publish, e.g.
//   {"total_price": base_price * $min([duration, 8]) / 8 * (resolution = "4k" ? 1.5 : 1)}
// Hand-written tokenizer + Pratt parser + tree walker. No eval/Function; fields resolve to own data only.
// Semantics follow JSONata where formulas depend on them: a missing field is undefined, comparisons
// against undefined are false, arithmetic on undefined stays undefined, array literals drop undefined.

const OPERATORS = [":=", "!=", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "%", "?", ":", ";", ",", "(", ")", "[", "]", "{", "}"];
const KEYWORDS = new Set(["and", "or", "in", "true", "false", "null"]);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1, value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") { value += src[j + 1] ?? ""; j += 2; } else value += src[j++];
      }
      if (j >= src.length) throw new SyntaxError("Unterminated string");
      tokens.push({ type: "str", value }); i = j + 1; continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ type: "num", value: Number(num[0]) }); i += num[0].length; continue; }
    const name = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      const word = name[0];
      tokens.push(word[0] === "$" ? { type: "var", value: word.slice(1) } : KEYWORDS.has(word) ? { type: "op", value: word } : { type: "name", value: word });
      i += word.length; continue;
    }
    const op = OPERATORS.find(o => src.startsWith(o, i));
    if (!op) throw new SyntaxError(`Unexpected character ${JSON.stringify(ch)}`);
    tokens.push({ type: "op", value: op }); i += op.length;
  }
  tokens.push({ type: "end" });
  return tokens;
}

// Binding powers, lowest to highest (JSONata order).
const BP = { ":=": 10, "?": 20, or: 25, and: 30, "=": 40, "!=": 40, "<": 40, "<=": 40, ">": 40, ">=": 40, in: 40, "+": 50, "-": 50, "*": 60, "/": 60, "%": 60, "[": 80 };

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = value => peek().type === "op" && peek().value === value;
  const expect = value => {
    if (!isOp(value)) throw new SyntaxError(`Expected ${value}`);
    pos++;
  };
  const list = (close, item) => {
    const items = [];
    if (!isOp(close)) do items.push(item()); while (isOp(",") && ++pos);
    expect(close);
    return items;
  };

  function prefix() {
    const t = tokens[pos++];
    if (t.type === "num" || t.type === "str") return { k: "lit", v: t.value };
    if (t.type === "name") return { k: "field", name: t.value };
    if (t.type === "var") {
      if (!isOp("(")) return { k: "var", name: t.value };
      pos++;
      return { k: "call", fn: t.value, args: list(")", () => expression(0)) };
    }
    if (t.type !== "op") throw new SyntaxError("Unexpected end of formula");
    if (t.value === "true" || t.value === "false") return { k: "lit", v: t.value === "true" };
    if (t.value === "null") return { k: "lit", v: null };
    if (t.value === "-") return { k: "neg", e: expression(70) };
    if (t.value === "[") return { k: "array", items: list("]", () => expression(0)) };
    if (t.value === "(") {
      const steps = [];
      if (!isOp(")")) do steps.push(expression(0)); while (isOp(";") && ++pos);
      expect(")");
      return { k: "block", steps };
    }
    if (t.value === "{") {
      return { k: "object", entries: list("}", () => {
        const key = tokens[pos++];
        if (key.type !== "str") throw new SyntaxError("Object keys must be strings");
        expect(":");
        return [key.value, expression(0)];
      }) };
    }
    throw new SyntaxError(`Unexpected ${t.value}`);
  }

  function expression(rbp) {
    let left = prefix();
    // get_duration(video, min=2, ...) — non-$ functions are WaveSpeed built-ins with named arguments.
    if (left.k === "field" && isOp("(")) {
      pos++;
      const args = [], named = {};
      if (!isOp(")")) do {
        if (peek().type === "name" && tokens[pos + 1].type === "op" && tokens[pos + 1].value === "=") {
          const key = tokens[pos].value; pos += 2; named[key] = expression(BP["="]);
        } else args.push(expression(0));
      } while (isOp(",") && ++pos);
      expect(")");
      left = { k: "builtin", fn: left.name, args, named };
    }
    while (peek().type === "op" && (BP[peek().value] ?? 0) > rbp) {
      const op = tokens[pos++].value;
      if (op === "[") { left = { k: "index", e: left, i: expression(0) }; expect("]"); }
      else if (op === "?") {
        const then = expression(0);
        let otherwise = null;
        if (isOp(":")) { pos++; otherwise = expression(0); }
        left = { k: "cond", c: left, then, otherwise };
      } else if (op === ":=") {
        if (left.k !== "var") throw new SyntaxError("Only $variables can be bound");
        left = { k: "bind", name: left.name, e: expression(BP[":="] - 1) };
      } else left = { k: "bin", op, l: left, r: expression(BP[op]) };
    }
    return left;
  }

  const ast = expression(0);
  if (peek().type !== "end") throw new SyntaxError("Unexpected trailing input");
  return ast;
}

function truthy(v) {
  if (Array.isArray(v)) return v.some(truthy);
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}
const num = (v, fn) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`${fn} expects a number`);
  return v;
};
const asArray = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const FUNCTIONS = {
  min: a => (asArray(a).length ? Math.min(...asArray(a).map(v => num(v, "$min"))) : undefined),
  max: a => (asArray(a).length ? Math.max(...asArray(a).map(v => num(v, "$max"))) : undefined),
  sum: a => asArray(a).reduce((s, v) => s + num(v, "$sum"), 0),
  ceil: v => (v === undefined ? undefined : Math.ceil(num(v, "$ceil"))),
  floor: v => (v === undefined ? undefined : Math.floor(num(v, "$floor"))),
  round: v => (v === undefined ? undefined : Math.round(num(v, "$round"))),
  abs: v => (v === undefined ? undefined : Math.abs(num(v, "$abs"))),
  count: v => asArray(v).length,
  exists: v => v !== undefined,
  boolean: v => (v === undefined ? undefined : truthy(v)),
  not: v => (v === undefined ? undefined : !truthy(v)),
  number: v => {
    if (v === undefined || typeof v === "number") return v;
    const n = typeof v === "boolean" ? Number(v) : Number(String(v).trim());
    if (String(v).trim() === "" || !Number.isFinite(n)) throw new TypeError("$number could not convert");
    return n;
  },
  string: v => (v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v)),
  lowercase: v => (v === undefined ? undefined : String(v).toLowerCase()),
  uppercase: v => (v === undefined ? undefined : String(v).toUpperCase()),
  length: v => (v === undefined ? undefined : String(v).length),
  split: (v, sep) => (v === undefined ? undefined : String(v).split(String(sep))),
};

// Seconds of the media input(s) WaveSpeed measures server-side. Each clip is clamped to [min, max],
// clips combine by sum (or max with aggregate="max"), and the total is capped at `total`.
function getDuration(media, opts, ctx) {
  const urls = asArray(media).filter(u => typeof u === "string" && u.trim());
  const lengths = urls.map(url => {
    const seconds = ctx.mediaDuration?.(url);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new Error(`Unknown duration for ${url}`);
    return Math.min(Math.max(seconds, opts.min ?? 0), opts.max ?? Infinity);
  });
  const combined = opts.aggregate === "max" ? Math.max(0, ...lengths) : lengths.reduce((s, v) => s + v, 0);
  return Math.min(combined, opts.total ?? Infinity);
}

function equal(a, b) {
  if (a === undefined || b === undefined) return false;
  return a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
}

function evaluate(node, vars, scope, ctx) {
  const ev = n => evaluate(n, vars, scope, ctx);
  switch (node.k) {
    case "lit": return node.v;
    case "field": return Object.hasOwn(vars, node.name) ? vars[node.name] : undefined;
    case "var": return scope.has(node.name) ? scope.get(node.name) : undefined;
    case "bind": { const v = ev(node.e); scope.set(node.name, v); return v; }
    case "block": { let v; for (const step of node.steps) v = ev(step); return v; }
    case "array": return node.items.map(ev).filter(v => v !== undefined);
    case "object": return Object.fromEntries(node.entries.map(([key, e]) => [key, ev(e)]));
    case "neg": { const v = ev(node.e); return v === undefined ? undefined : -num(v, "-"); }
    case "cond": return truthy(ev(node.c)) ? ev(node.then) : node.otherwise ? ev(node.otherwise) : undefined;
    case "index": {
      const target = ev(node.e), i = ev(node.i);
      if (typeof i !== "number") throw new TypeError("Only numeric indexes are supported");
      const arr = asArray(target);
      return arr[i < 0 ? arr.length + i : Math.floor(i)];
    }
    case "call": {
      const fn = Object.hasOwn(FUNCTIONS, node.fn) ? FUNCTIONS[node.fn] : null;
      if (!fn) throw new ReferenceError(`Unsupported function $${node.fn}`);
      return fn(...node.args.map(ev));
    }
    case "builtin": {
      if (node.fn !== "get_duration") throw new ReferenceError(`Unsupported function ${node.fn}`);
      const opts = Object.fromEntries(Object.entries(node.named).map(([key, e]) => [key, ev(e)]));
      return getDuration(ev(node.args[0]), opts, ctx);
    }
    case "bin": {
      const { op } = node;
      if (op === "and") return truthy(ev(node.l)) && truthy(ev(node.r));
      if (op === "or") return truthy(ev(node.l)) || truthy(ev(node.r));
      const l = ev(node.l), r = ev(node.r);
      if (op === "=") return equal(l, r);
      if (op === "!=") return l !== undefined && r !== undefined && !equal(l, r);
      if (op === "in") return l !== undefined && asArray(r).some(v => equal(l, v));
      if (l === undefined || r === undefined) return op === "<" || op === "<=" || op === ">" || op === ">=" ? false : undefined;
      if (op === "<" || op === "<=" || op === ">" || op === ">=") {
        if (typeof l !== typeof r || (typeof l !== "number" && typeof l !== "string")) throw new TypeError(`Cannot compare with ${op}`);
        return op === "<" ? l < r : op === "<=" ? l <= r : op === ">" ? l > r : l >= r;
      }
      const a = num(l, op), b = num(r, op);
      return op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    default: throw new Error(`Unknown node ${node.k}`);
  }
}

const compiled = new Map();

// Parse once, evaluate many times. Returns (vars, ctx) => total_price.
export function compileFormula(src) {
  if (!compiled.has(src)) {
    const ast = parse(src);
    compiled.set(src, (vars = {}, ctx = {}) => {
      const result = evaluate(ast, vars, new Map(), ctx);
      return result && typeof result === "object" && !Array.isArray(result) ? result.total_price : result;
    });
  }
  return compiled.get(src);
}

// total_price in WaveSpeed's units (millionths of a dollar, before discount). Throws on anything it cannot price.
export function evaluateFormula(src, vars = {}, ctx = {}) {
  return compileFormula(src)(vars, ctx);
}
