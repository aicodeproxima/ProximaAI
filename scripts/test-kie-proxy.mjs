// The kie.ai proxy's request rules (src/lib/kieProxy.js, used by api/kie-proxy.ts). Written first: before the module exists
// every test fails. docs/SECOND-ACCOUNT-PLAN.md S2: exactly four kie.ai calls pass, and the browser never chooses where
// results are sent (callBackUrl is stripped until the kie.ai webhook step exists).
// Run: node scripts/test-kie-proxy.mjs
import assert from "node:assert/strict";

let K;
try { K = await import("../src/lib/kieProxy.js"); } catch { K = {}; }
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
const up = (...a) => K.kieUpstream(...a);
const q = (o = {}) => new URLSearchParams(o);

await test("createTask forwards only model and input (callBackUrl and anything else dropped)", () => {
  const r = up("POST", "api/v1/jobs/createTask", q(), JSON.stringify({
    model: "nano-banana-pro", input: { prompt: "a cat", aspect_ratio: "1:1" },
    callBackUrl: "https://evil.example/hook", progressCallBackUrl: "https://evil.example/p", extra: 1 }));
  assert.equal(r.ok, true);
  assert.equal(r.method, "POST");
  assert.equal(r.url, `${K.KIE_BASE}/api/v1/jobs/createTask`);
  assert.deepEqual(JSON.parse(r.body), { model: "nano-banana-pro", input: { prompt: "a cat", aspect_ratio: "1:1" } });
});

await test("createTask refuses a missing or malformed model / input, and a body that is not JSON", () => {
  for (const body of [
    JSON.stringify({ input: {} }), JSON.stringify({ model: "", input: {} }), JSON.stringify({ model: "a b", input: {} }),
    JSON.stringify({ model: "x".repeat(129), input: {} }), JSON.stringify({ model: "m" }), JSON.stringify({ model: "m", input: [] }),
    JSON.stringify({ model: "m", input: "s" }), JSON.stringify([1]), "not json", "",
  ]) {
    const r = up("POST", "api/v1/jobs/createTask", q(), body);
    assert.equal(r.ok, false, body);
    assert.equal(r.status, 400);
  }
});

await test("createTask refuses a body over 1 MB", () => {
  const r = up("POST", "api/v1/jobs/createTask", q(), JSON.stringify({ model: "m", input: { prompt: "x".repeat(1024 * 1024) } }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

await test("recordInfo forwards only a well-formed taskId", () => {
  const r = up("GET", "api/v1/jobs/recordInfo", q({ taskId: "abc_123-XYZ", other: "1", callBackUrl: "x" }), "");
  assert.equal(r.ok, true);
  assert.equal(r.url, `${K.KIE_BASE}/api/v1/jobs/recordInfo?taskId=abc_123-XYZ`);
  assert.equal(r.body, undefined);
  for (const id of ["", "a/b", "a b", "x".repeat(129), "../x"]) assert.equal(up("GET", "api/v1/jobs/recordInfo", q({ taskId: id }), "").ok, false, id);
  assert.equal(up("GET", "api/v1/jobs/recordInfo", q(), "").ok, false);
});

await test("S3 review #1: kie.ai's own task ids (with a dot, e.g. Kling's task_kling-3.0_<ms>) pass the poll", () => {
  for (const id of ["task_kling-3.0_1765187774173", "task_nano-banana-pro_1765178625768", "task_wan_1765172284434"]) {
    const r = up("GET", "api/v1/jobs/recordInfo", q({ taskId: id }), "");
    assert.equal(r.ok, true, id);
    assert.equal(r.url, `${K.KIE_BASE}/api/v1/jobs/recordInfo?taskId=${id}`);
  }
});

await test("credit is a bare GET", () => {
  const r = up("GET", "api/v1/chat/credit", q({ a: "1" }), "");
  assert.equal(r.ok, true);
  assert.equal(r.url, `${K.KIE_BASE}/api/v1/chat/credit`);
});

await test("download-url forwards only an https url", () => {
  const r = up("POST", "api/v1/common/download-url", q(), JSON.stringify({ url: "https://tempfile.aiquickdraw.com/a/b.png", x: 1 }));
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.body), { url: "https://tempfile.aiquickdraw.com/a/b.png" });
  for (const url of ["http://x.com/a.png", "javascript:alert(1)", "", 5, "https://" + "x".repeat(2050)])
    assert.equal(up("POST", "api/v1/common/download-url", q(), JSON.stringify({ url })).ok, false, String(url));
});

await test("every other path or method is refused (no chat, no traversal, no wrong verb)", () => {
  const cases = [
    ["POST", "api/v1/chat/completions"], ["GET", "api/v1/jobs/createTask"], ["POST", "api/v1/jobs/recordInfo"],
    ["POST", "api/v1/chat/credit"], ["GET", "api/v1/common/download-url"], ["POST", "api/file-url-upload"],
    ["POST", "api/v1/jobs/../jobs/createTask"], ["POST", "/api/v1/jobs/createTask/"], ["DELETE", "api/v1/jobs/createTask"],
    ["GET", ""], ["GET", "https://evil.example/api/v1/chat/credit"],
  ];
  for (const [m, p] of cases) {
    const r = up(m, p, q({ taskId: "abc" }), JSON.stringify({ model: "m", input: {}, url: "https://a.b/c" }));
    assert.equal(r.ok, false, `${m} ${p}`);
  }
});

await test("a leading slash is accepted (the rewrite may keep it)", () => {
  assert.equal(up("GET", "/api/v1/chat/credit", q(), "").ok, true);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
