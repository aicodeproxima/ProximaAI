// ─── Live updates: the content-free "something changed" ping ───
// After every statement that changes tasks/history, the database broadcasts an EMPTY message on a secret Realtime topic
// (migration 20261022100000). Only a valid session learns the topic (get_my_account.sync_topic); it rotates on rename,
// password change, backup-code unlock and signing-key rotation, and every reconcile re-reads it. A ping only schedules a
// reconcile, which then reads the cloud through the session-checked REST calls. It replaced postgres_changes: Realtime
// cannot see the session header, and its DELETE events carried primary keys to anyone holding the publishable key.
export function createSyncPing(getClient) {
  let topic = null, channel = null, listener = null;
  const close = () => {
    const c = getClient();
    if (channel && c) c.removeChannel(channel);
    channel = null;
  };
  const open = () => {
    const c = getClient();
    if (!c || !listener || !topic) return;
    channel = c.channel(topic).on("broadcast", { event: "changed" }, () => listener?.()).subscribe();
  };
  return {
    setTopic(next) {
      if (typeof next !== "string" || !next || next === topic) return;
      topic = next;
      close(); open();
    },
    subscribe(onChange) {
      listener = onChange;
      close(); open();
      return () => { listener = null; close(); };
    },
    get topic() { return topic; },
  };
}
