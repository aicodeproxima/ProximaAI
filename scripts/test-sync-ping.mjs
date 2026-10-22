// Tests for src/lib/syncPing.js — the content-free "something changed" ping that replaced postgres_changes.
// Run: node scripts/test-sync-ping.mjs
import assert from "node:assert/strict";
const { createSyncPing } = await import("../src/lib/syncPing.js");

// A fake supabase-js client: records channels and lets a test deliver a broadcast.
function fakeClient() {
  const c = { opened: [], removed: [] };
  c.channel = (topic) => {
    const ch = { topic, handlers: [], subscribed: false };
    ch.on = (type, filter, fn) => { ch.handlers.push({ type, event: filter?.event, fn }); return ch; };
    ch.subscribe = () => { ch.subscribed = true; return ch; };
    c.opened.push(ch);
    return ch;
  };
  c.removeChannel = (ch) => { c.removed.push(ch); };
  c.deliver = (ch, event = "changed") => ch.handlers.filter(h => h.type === "broadcast" && h.event === event).forEach(h => h.fn({ payload: {} }));
  return c;
}

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

test("a topic learned before subscribing opens one channel on subscribe; a ping calls the listener", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c); let hits = 0;
  ping.setTopic("proxima-sync-aa");
  assert.equal(c.opened.length, 0, "no listener yet: nothing opened");
  ping.subscribe(() => hits++);
  assert.equal(c.opened.length, 1);
  assert.equal(c.opened[0].topic, "proxima-sync-aa");
  assert.ok(c.opened[0].subscribed);
  c.deliver(c.opened[0]);
  assert.equal(hits, 1);
  c.deliver(c.opened[0], "other-event");
  assert.equal(hits, 1, "only the 'changed' event counts");
});

test("subscribing before the topic is known waits; the topic (from get_my_account) then opens the channel", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c); let hits = 0;
  ping.subscribe(() => hits++);
  assert.equal(c.opened.length, 0);
  ping.setTopic("proxima-sync-aa");
  assert.equal(c.opened.length, 1);
  c.deliver(c.opened[0]);
  assert.equal(hits, 1);
});

test("the same topic again changes nothing (every reconcile re-reads it)", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c);
  ping.subscribe(() => {});
  ping.setTopic("proxima-sync-aa"); ping.setTopic("proxima-sync-aa"); ping.setTopic("proxima-sync-aa");
  assert.equal(c.opened.length, 1);
  assert.equal(c.removed.length, 0);
});

test("a rotated topic (rename, password change, unlock) closes the old channel and opens the new one", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c); let hits = 0;
  ping.subscribe(() => hits++);
  ping.setTopic("proxima-sync-aa");
  ping.setTopic("proxima-sync-bb");
  assert.deepEqual(c.opened.map(ch => ch.topic), ["proxima-sync-aa", "proxima-sync-bb"]);
  assert.deepEqual(c.removed.map(ch => ch.topic), ["proxima-sync-aa"]);
  c.deliver(c.opened[1]);
  assert.equal(hits, 1);
});

test("unsubscribe closes the channel; later topics open nothing; a ping on the closed channel is ignored", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c); let hits = 0;
  const off = ping.subscribe(() => hits++);
  ping.setTopic("proxima-sync-aa");
  off();
  assert.deepEqual(c.removed.map(ch => ch.topic), ["proxima-sync-aa"]);
  ping.setTopic("proxima-sync-bb");
  assert.equal(c.opened.length, 1);
  c.deliver(c.opened[0]);
  assert.equal(hits, 0);
});

test("a re-subscribe (effect re-run) replaces the listener and keeps exactly one channel open", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c); let a = 0, b = 0;
  const offA = ping.subscribe(() => a++);
  ping.setTopic("proxima-sync-aa");
  offA();
  ping.subscribe(() => b++);
  assert.equal(c.opened.length, 2);
  assert.equal(c.removed.length, 1);
  c.deliver(c.opened[1]);
  assert.deepEqual([a, b], [0, 1]);
});

test("junk topics are ignored; no client means nothing opens", () => {
  const c = fakeClient(); const ping = createSyncPing(() => c);
  ping.subscribe(() => {});
  for (const t of [null, undefined, "", 42, {}]) ping.setTopic(t);
  assert.equal(c.opened.length, 0);
  const none = createSyncPing(() => null);
  none.subscribe(() => {}); none.setTopic("proxima-sync-aa");
  assert.equal(none.topic, "proxima-sync-aa");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
