// Comments out of JS/JSX source, for the wiring tests that read App.jsx as text (a commented-out line must never satisfy
// a check). Tested by scripts/test-strip-comments.mjs.
// Review r8 (tests #13): a block comment starts only where `/*` follows the start of the text, whitespace or one of
// { ( , ; = , never inside a word: App.jsx's string literals "image/*" and "video/*" used to be read as comment openers,
// which silently dropped about 106 lines. A line comment is `//` not after `:` (a URL), a quote or a backslash.
export function stripComments(src) {
  return String(src).replace(/\r\n/g, "\n")
    .replace(/(^|[\s{(,;=])\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/gm, "$1");
}

// Strips, then checks that every one-line string literal holding `/*` is still there (a stripper that misreads one loses
// code without saying so). Throws on a lost literal; answers the stripped text.
export function assertStripKeepsStrings(src, stripped = stripComments(src)) {
  const text = String(src).replace(/\r\n/g, "\n");
  for (const m of text.matchAll(/"[^"\n]*\/\*[^"\n]*"|'[^'\n]*\/\*[^'\n]*'/g)) {
    if (!stripped.includes(m[0])) throw new Error(`comment stripper dropped the string ${m[0]}`);
  }
  return stripped;
}
