import { useState, useEffect, useRef, useCallback, useReducer, useMemo, memo } from "react";
import { MODELS, TYPE_LABELS, TYPE_ICONS, PROVIDER_COLORS } from "./config/models.js";
import { CATALOG, visibleModels, editModelFor } from "./config/catalog.js";
import { createUnsentPublisher } from "./lib/unsentPublish.js";
import { isKieModelId, isKieGeneration, isKiePollUrl, KIE_CREDIT_USD } from "./lib/kie.js";
import { buildPayload, chosenResolution, getEffectiveImageBatchCount, getImageBatchLimit, planImageBatchRequests } from "./lib/payloadBuilder.js";
import { requestCost } from "./lib/pricing.js";
import { draftTask, unitQuote, taskUserSettings, effectivePerModelRes, labelPerModelRes, resolutionNotes, runLabels } from "./lib/taskDraft.js";
import { probeMediaDuration } from "./lib/mediaDuration.js";
import { submitTask, pollResult, listPredictions, deletePredictions, checkBalance, checkKieBalance, uploadMedia, API_BASE } from "./lib/api.js";
import { queueDeletes, dropDeletes, dueDeletes, settleDeletes, failDeletes, holdHeldIds, waitHeldIds } from "./lib/wsDelete.js";
import { getSession, setSession, clearSession, onSessionExpired, bindPageAccount, pageAccountId, onForeignSession } from "./lib/session.js";
import useUpdateAvailable from "./lib/updateCheck.js";
import VersionInfo from "./lib/VersionInfo.jsx";
import { downscaleImage } from "./lib/imageUpload.js";
import { getSetting, hasLocalData, setSetting, cachedProviderKeys, cacheProviderKeys, formStamp, advanceFormStamp, addHistoryEntry, getHistory, allStoredHistory, deleteHistoryEntries, migrateFromLocalStorage, saveTask, saveTasks, deleteTask, deleteTasks, getCompletedTasks, getPendingTasks, allStoredTasks, getStorageStats, getFailedSyncs, addFailedSync, removeFailedSync, clearFailedSyncs, peekQueuedUploads, takeQueuedUploads, putBackQueuedUploads, queueDeleteIntents, confirmDeleteIntents, withoutConfirmedUploads, uploadable, uploadBlockedIds, withoutBlockedItems, confirmSeqNow, sharedDeleteState, settledDeletingIds, intentGroups, forgetConfirmed, dropDeleteIntentsBefore, restoreGuard, markRestoreSeen, rekeyFavoriteRetries, releasePredictions, releasedPredictions, sentVersion, recordClaimants, storedClaimants, resolveClaimants, claimantRecords, putBackClaimants, replaceQueuedUpload, pendingDeleteIds, readWsDeletes, writeWsDeletes, readFileDeletes, writeFileDeletes, publishFormPaths, readFormPublications, forgetFormPaths, browserId, buildClearStash, writeClearStash, readClearStashes, readClearStash, dropClearStash, stashGiveBack, recordStashArchive, stashArchivePaths, chainedFavoritesBefore, clearLogsStash, voidedClearStashes, voidDeleteIntents, voidedTimes, stashDecision, dropGivenBackStash, inlineVoidPutBack, pruneVoidedAt, beginDeleteFlight, endDeleteFlight, knownRestoreAt, historyUploadPlan, holdPurgeDeletes, releaseHeldPurges, heldPurgeLeft, heldDeleteRefs, inFlightIds, deleteHoldAt, recordStashPrediction, reserveDelete, holdDeletingWsEntries, storedEvidenceIds, hasHeldPurges, heldGoneCandidates, holdLateResult, holdArchiveFiles, readyRelinks, dropRelinks, unreleasePredictions, releaseAbortedLate, markHistoryResync, historyResyncDue, markAssumedConfirms, relinksOf, intoLoadedView, unsentUploadPaths, unsentGenerations, saveTasksNow, addHistoryEntriesNow, storedKeptIds, unsentRowsIn } from "./lib/storage.js";
import { backupNotice } from "./lib/backupNotice.js";
import { signInError, signInSwitchesToUnlock, backupCodeError, accountError, joinError, joinedNote, JOIN_BROWSER_TAKEN, JOIN_MAYBE_CREATED, COPY_BY_HAND, SESSION_EXPIRED, SIGNIN_HINT, OFFLINE_SIGNIN, OFFLINE } from "./lib/signinText.js";
import { readBrowserAccount, browserAccountDecision, claimBrowser, browserAccountMessage, freeForNewAccount, bootSessionDecision, tokenAccountId,
  pageMustLeave, accountCheckStep, BROWSER_ACCOUNT_KEY, readJoinedNote, rememberJoinedNote, forgetJoinedNote } from "./lib/accountGuard.js";
import InviteSection from "./components/InviteSection.jsx";
import { clearSettlement } from "./lib/clearOutcome.js";
import { SNAPSHOT_SLACK_MS, serverNow } from "./lib/serverClock.js";
import { initSupabase, isSupabaseConfigured, pullSettings, pullRestoreAt, joinWithInvite, setPageExiting, backfillTaskInputs, deleteQueuedRemote, predictionsInUseRemote, generationsLiveRemote, pullTaskInputs, syncHistoryEntry as rawSyncHistoryEntry, syncTask as rawSyncTask, syncTasksBatch as rawSyncTasksBatch, pullTaskStartsInWindow, syncSetting, pullAllRemoteData, pullCloudIds, syncHistoryBatch as rawSyncHistoryBatch, subscribeToCloudChanges, deleteTasksRemote, clearQueuedRemote, resetQueuedRemote, serverTimeRemote, deleteHistoryRemote, upsertQueuedHistory as rawUpsertQueuedHistory, getDeviceId, resetDeviceIdCache, checkSession, signIn, unlockWithBackupCode, getMyAccount, setMyAccount, changeMyPassword, renameMyAccount, setBackupCode, saveWavespeedKey, myProviderKeys, saveProviderKey, clearProviderKey, sendEmailOtp, verifyEmailOtp, createBackup, listBackups, restoreBackup, deleteBackup, archiveUrl, deleteArchivedPath, getArchiveStats, getAutoBackups, setAutoBackups, pullAllForPurge, pathsInUseRemote, pullFormHolds, taskRowsPresentRemote } from "./lib/supabase.js";
import { planDeleteStage, ownedPaths, publicUrlOf, pathsInUse, relinkHold, elsewherePurge, entriesWithout } from "./lib/purge.js";
import { queueFileDeletes, dueFileDeletes, settleFileDelete, headOutcome, headStatus, pendingOf, heldOf, purgeNote, historyLeft, fileFlushReady, classifyPath, liveFormPaths, formPublishDue, sameFormSet, liveUnsent } from "./lib/fileDelete.js";
import { THEMES, BACKGROUNDS } from "./lib/themes.js";
import useTheme from "./lib/useTheme.js";
import BackgroundLayer from "./lib/BackgroundLayer.jsx";
import { planTaskSync, planLogSync, applyCloudUpdate, inputBackfill, historyRemovals, tombstonedItems } from "./lib/syncReconcile.js";
import { batchLogItems, finishLogs, isOpenLog, sameLogContent, takeFinishedFromCloud, purgeLogsForDeleted, mergeLogs, restoredVersions, historyOnlyGenerations, restoreStrippedLogs } from "./lib/batchLog.js";
import { mergeLoadedTasks, applyPoll, settlePoll, retryTask, nextPollDelay, pollErrorAction, planRepoll, isOrphan, orphanWindows, planOrphans, lostKieSubmits, KIE_LOST_ERROR, claimantLookupNeeded, planClaimOutcomes, lookupStale, unambiguousDeletes, submitMayHaveLanded, isInFlight, keyStatusAfter, ORPHAN_GRACE_MS, LOOKUP_SKEW_MS, failTask, EXPIRED_ERROR, RESUME_WINDOW_MS } from "./lib/taskResume.js";
import { MODEL_FAVORITES_SETTING, createModelFavoritesSetting, emptyModelFavorites, getCategoryFavoriteIds, readModelFavoritesSetting, toggleModelFavorite as toggleFavoriteInMap } from "./lib/modelFavorites.js";

// Archived files nothing will own any more (a held archive whose clear was confirmed, review round 15 S5) go through
// the durable file-delete queue, as a purge's do (stagePurge); a path a kept generation uses is never deleted.
function queueArchivedFileDeletes(paths) {
  const list = (paths || []).filter(Boolean);
  if (list.length) writeFileDeletes(queueFileDeletes(readFileDeletes(), list, Date.now()));
}
// Review round 24 #2: what a delete says when it cannot hold its files and WaveSpeed deletes (stagePurge: no room in
// localStorage). It stops before any server call; nothing was deleted.
const STORAGE_FULL_TOAST = "This device's storage is full — nothing was deleted. Free some space (or let pending uploads finish) and try again.";
// Task B12b (review round 25 #3): the reconcile pass reads only the newest History entries (supabase.js pullAllRemoteData:
// pullHistory(1000)); a read that returned this many may have left older entries out (the held-delete evidence is then
// confirmed with the server, generations_live).
const HISTORY_PULL_LIMIT = 1000;
// Task B12a (review round 25 #18): a WaveSpeed result of a deleted generation that could not be held nor queued.
const WS_DELETE_FULL_TOAST = "This device's storage is full — a deleted generation's WaveSpeed result could not be queued for deletion. Free some space.";
// confirmDeleteIntents plus the files of archives a clear held for the confirmed tasks (storage.js forgetStashedIds).
// Every confirm goes through here (review round 19 #3): the ids leave the queue, every clear stash (their held archives'
// files deleted) and the upload queue (a confirmed delete is never uploaded again). `at` (task B7b, review round 20 #7):
// the queue time of the group the cloud answered; an intent of these ids queued later is another delete, still pending.
// Task B13a (review round 26 #3/#5): `opts.assumed` records the confirm without the final mark (storage.js
// confirmDeleteIntents): only for ids the server left alone on purpose (Clear Outputs' unnamed History-only ids a read
// found a row for).
function confirmIntents(kind, ids, at, opts) {
  queueArchivedFileDeletes(confirmDeleteIntents(kind, ids, at, opts));
}
// Review round 19 #1: after voidDeleteIntents, only the ids with no intent of that kind left stop being "deleted" here; an
// id a later delete re-queued (another tab, a re-press during the call) is still going.
function releaseVoided(ref, kind, ids) {
  const still = pendingDeleteIds(kind);
  for (const id of ids || []) if (id && !still.has(id)) ref.current.delete(id);
}

// Task B7a (review round 20 #1, #3, #5): the ONLY senders of task and History rows. Each passes its rows through the
// shared upload filter (storage.js uploadable: no id with a delete intent pending in any tab, none whose delete was
// confirmed and not released by a restore), so a stale tab's copy can never bring a confirmed delete back, whatever path
// it takes (reconcile, persistence, replays, archive, unload flush). Each resolves to the rows it sent, so a caller
// clears only their queue entries. scripts/test-delete-wiring.mjs checks that nothing else calls the raw senders.
async function sendTasks(tasks) {
  const send = uploadable("task", tasks);
  if (send.length) await rawSyncTasksBatch(send);
  return send;
}
async function sendTask(task) {
  const send = uploadable("task", [task]);
  if (send.length) await rawSyncTask(send[0]);
  return send;
}
// Task B15 (review round 28 #4/#2): this browser's rows not uploaded yet, published in settings
// form-inputs:<browser>:unsent (a key no previous build writes; the server treats every form-inputs:% row as a form hold),
// shared by the publish effect and the History senders. Resolves true once the cloud holds the current set, false when the
// write failed. `exiting`: the pagehide publication (keepalive). Task B17 (review round 30 #1/#2): src/lib/unsentPublish.js
// sends every publication at once (round 29's chain held a frozen page's later rows back until it thawed); the server keeps
// the newest set (20261025900000), stamped monotonic per browser on the server-aligned clock (storage.js formStamp).
const unsentPublisher = createUnsentPublisher({
  configured: isSupabaseConfigured,
  compute: unsentGenerations,
  now: () => formStamp(serverNow()),
  due: formPublishDue,
  send: (value) => syncSetting(`form-inputs:${browserId()}:unsent`, value),
  onExit: () => setPageExiting(true),
  staleAt: formStaleAt,
  advance: advanceFormStamp,
});
function publishUnsent(opts = {}) { return unsentPublisher.publish(opts); }
// The stored stamp a stale-stamp refusal names (20261025900000: PT409, the stored `at` as detail), else NaN.
function formStaleAt(e) { return e?.code === "PT409" ? Number(e.details) : NaN; }
// The form row (form-inputs:<browser>): sent like the :unsent row, once more above the stored stamp after a stale refusal,
// with the set computed again (the stored, newer row may come from another tab that saw more; resending the set computed
// before it would erase that newer hold: B17 verification). Resolves {at, paths} as sent.
async function sendFormRow(paths, recompute) {
  const at = formStamp(serverNow());
  try {
    await syncSetting("form-inputs:" + browserId(), { at, paths });
    return { at, paths };
  } catch (e) {
    const stored = formStaleAt(e);
    if (!Number.isFinite(stored)) throw e;
    advanceFormStamp(stored);
    const again = formStamp(serverNow()), fresh = recompute();
    await syncSetting("form-inputs:" + browserId(), { at: again, paths: fresh });
    return { at: again, paths: fresh };
  }
}
const localFormPaths = () => [...liveFormPaths(readFormPublications(), Date.now())];
// Before a History upload: an entry naming a generation whose own row is still queued here goes out only once a confirmed
// publication names that generation (a phone frozen right after Generate: its entry reached the cloud, its row did not,
// and another device deleted the WaveSpeed result of a generation that then landed). The write failed: the upload throws
// and stays queued, with its rows, so the cloud never shows such an item without the hold.
async function publishUnsentBefore(entries) {
  if (unsentRowsIn(entries).length && !(await publishUnsent())) throw new Error("rows not uploaded yet could not be published");
}

// Task B8a (review round 21 #1/#5): no History upload carries an item of a deleted task: such items are stripped here,
// centrally, and an entry left with no item is not sent (storage.js withoutBlockedItems). Task B9 (review round 22 #5/#7):
// only items of FINAL confirmed deletes are stripped (a pending delete's own transaction strips its items on the server,
// and a void keeps them); an entry holding an item of a superseded confirm or of a delete call in flight waits (not sent).
// A stripped or held entry's queued copy stays queued (sentVersion no longer matches) until replayHistoryUploads, which
// plans the same way, sends or drops it.
async function sendHistory(entries) {
  let send = uploadable("history", withoutBlockedItems(entries));
  // Task B15 (review round 28 #4): rows not uploaded yet are published first, only when an entry names one; the entries are
  // then filtered AGAIN: a delete confirmed while that write was on the wire (another tab) is never uploaded.
  if (send.length && unsentRowsIn(send).length) {
    await publishUnsentBefore(send);
    send = uploadable("history", withoutBlockedItems(send));
  }
  if (send.length) await rawSyncHistoryBatch(send);
  return send;
}
// `opts.strip: false` (review round 23 #4, persistLog): an entry holding an item of a FINAL confirmed delete is not sent
// at all (storage.js historyUploadPlan): only a sender that read the restore marker first strips it.
async function sendHistoryEntry(entry, opts) {
  let send = uploadable("history", withoutBlockedItems([entry], opts));
  if (send.length && unsentRowsIn(send).length) {   // task B15: as in sendHistory
    await publishUnsentBefore(send);
    send = uploadable("history", withoutBlockedItems(send, opts));
  }
  if (send.length) await rawSyncHistoryEntry(send[0]);
  return send;
}
// A delete's restore-checked History rewrites (upsert_queued_history): a left-out entry is neither upserted nor voided.
async function sendQueuedHistory(entries, queuedAt) {
  const send = uploadable("history", withoutBlockedItems(entries));
  return send.length ? rawUpsertQueuedHistory(send, queuedAt) : { ok: true, voided: [], upserted: [] };
}

// ─── LOGIN SCREEN ───
// Sign-in is checked on the server (bcrypt). Three failed attempts lock it; the backup code set in
// Settings → Account unlocks it (and can set a new password if the old one is forgotten).
const loginInputStyle = {
  width: "100%", background: "rgba(10,20,40,0.5)", border: "1px solid rgba(99,102,241,0.15)",
  borderRadius: 10, padding: "12px 14px", color: "#f1f5f9", fontFamily: `'JetBrains Mono', 'Fira Code', monospace`, fontSize: 15,
  outline: "none", boxSizing: "border-box", transition: "border-color 0.3s, box-shadow 0.3s",
};
const loginFocus = e => { e.target.style.borderColor = "#6366f1"; e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)"; };
const loginBlur = e => { e.target.style.borderColor = "rgba(99,102,241,0.15)"; e.target.style.boxShadow = "none"; };

// Server answers in words (signin, backup code, account RPCs): src/lib/signinText.js. One generic text per screen, so
// a stranger never learns whether a name exists or is locked (P1-AUTH-DESIGN §5 C0); works with the old and new server.

// The backup code is masked with CSS and is not a password field. Password managers would still take the last text
// field before a new-password field as the USERNAME (autocomplete="off" is ignored), so every code field is marked
// autocomplete="one-time-code" (never a username candidate) and each reset form carries a real username field first.
const maskedCodeStyle = (shown) => (shown ? {} : { WebkitTextSecurity: "disc" });
const visuallyHidden = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", border: 0 };

// Second account S4 (review r6 #4/#8): an invite link (#join, or #join=<code>) is taken by the app, at load and on a hash
// change, wherever the app is, and removed from the address at once. Returns { code } or null.
function takeJoinHash() {
  const m = /^#join(?:=([^&]*))?(?:&.*)?$/i.exec(window.location.hash || "");
  if (!m) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  let code = "";
  if (m[1]) { try { code = decodeURIComponent(m[1]); } catch { code = m[1]; } }
  return { code };
}

function LoginScreen({ onSignedIn, notice = "", refusal = "", joinLink = null }) {
  const [mode, setMode] = useState("signin"); // "signin" | "reset" (forgot password) | "unlock" (locked out) | "join" (invite)
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(refusal);   // review r6 #10: a refusal reads as an error, not a success notice
  const [info, setInfo] = useState(notice);
  const [loading, setLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [joined, setJoined] = useState(null);   // { backupCode, claimed, session }: the new account's code, shown once before sign-in
  const [savedCode, setSavedCode] = useState(false);
  const [joinNetFailed, setJoinNetFailed] = useState(false);   // a join's answer was lost: the account may exist (review r6 #7)
  const font = `'JetBrains Mono', 'Fira Code', monospace`;

  // Second account S4: an invite link (taken by the app, takeJoinHash) opens the join form, its code filled in when the link
  // carries one. Review r6 #7: an account made here whose page was lost before CONTINUE opens sign-in with its name.
  useEffect(() => {
    if (!joinLink) return;
    setMode("join"); setError("");
    if (joinLink.code) setInviteCode(joinLink.code);
  }, [joinLink]);
  useEffect(() => {
    const note = readJoinedNote();
    if (note && !joinLink) { setUsername(note); setInfo(joinedNote(note)); }
  }, []);
  // Review r6 #11: the join form says at once when this browser already holds an account's data.
  useEffect(() => {
    if (mode !== "join" || joined) return;
    let cancelled = false;
    (async () => {
      if (!freeForNewAccount({ stored: readBrowserAccount(), hasLocalData: await hasLocalData() }) && !cancelled) setError(JOIN_BROWSER_TAKEN);
    })();
    return () => { cancelled = true; };
  }, [mode, joined]);
  const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

  // Secrets never outlive the attempt or the mode they were typed in.
  function clearSecrets() { setPassword(""); setBackupCode(""); setNewPassword(""); setConfirmPassword(""); setShowCode(false); }
  function switchMode(next) { clearSecrets(); setError(""); setInfo(""); setMode(next); }

  async function handleSignIn(e) {
    e.preventDefault();
    if (!username.trim() || !password || loading) return;
    setLoading(true); setError(""); setInfo("");
    try {
      const r = await signIn(username.trim(), password);
      if (r.ok) {
        // Second account S5 (src/lib/accountGuard.js): this browser's data belongs to one account; another one is refused
        // here, before its session is kept.
        const verdict = browserAccountDecision({ stored: readBrowserAccount(), hasLocalData: await hasLocalData(), account: { id: r.account_id, role: r.role, username: r.username } });
        if (!verdict.ok) { clearSecrets(); setError(browserAccountMessage(verdict)); return; }
        if (verdict.claim && !claimBrowser({ id: r.account_id, role: r.role, username: r.username })) { clearSecrets(); setError(browserAccountMessage({ reason: "claim-failed" })); return; }
        forgetJoinedNote();
        clearSecrets(); onSignedIn({ token: r.token, expires_at: r.expires_at, username: r.username }); return;
      }
      setPassword("");
      // attempts_left / not_provisioned are never shown. Only the OLD server (before M1) answers `locked`: switch to
      // unlock mode with its message (design §5); the new server's answers are generic.
      if (signInSwitchesToUnlock(r)) switchMode("unlock");
      setError(signInError(r));
    } catch {
      setError(OFFLINE_SIGNIN);
    } finally {
      setLoading(false);
    }
  }

  // Second account S4: a member account from an invite (supabase/migrations/20261026500000_mu_p5_invites.sql). Only from a
  // browser no account's data is in (S5); the backup code is shown once, and the session kept only after it was saved.
  async function handleJoin(e) {
    e.preventDefault();
    if (!inviteCode.trim() || !username.trim() || !password || loading) return;
    if (password.length < 8) { setError(joinError({ reason: "weak_password" })); return; }
    if (password !== confirmPassword) { setError("Passwords don't match"); return; }
    setLoading(true); setError(""); setInfo("");
    try {
      if (!freeForNewAccount({ stored: readBrowserAccount(), hasLocalData: await hasLocalData() })) { setError(JOIN_BROWSER_TAKEN); return; }
      const r = await joinWithInvite(inviteCode.trim(), username.trim(), password);
      if (!r?.ok) { setPassword(""); setConfirmPassword(""); setError(joinNetFailed && r?.reason === "invalid" ? `${joinError(r)} ${JOIN_MAYBE_CREATED}` : joinError(r)); return; }
      const claimed = claimBrowser({ id: r.account_id, role: "member", username: r.username });
      rememberJoinedNote(r.username);
      setPassword(""); setConfirmPassword(""); setInviteCode(""); setSavedCode(false);
      setJoined({ backupCode: r.backup_code, claimed, session: { token: r.token, expires_at: r.expires_at, username: r.username } });
    } catch {
      setJoinNetFailed(true);
      setError(`${OFFLINE} ${JOIN_MAYBE_CREATED}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleBackupCode(e) {
    e.preventDefault();
    if (!username.trim() || !backupCode.trim() || loading) return;
    const resetting = mode === "reset";
    if (resetting && newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (resetting && newPassword !== confirmPassword) { setError("New passwords don't match"); return; }
    setLoading(true); setError(""); setInfo("");
    try {
      const r = await unlockWithBackupCode(backupCode.trim(), resetting ? newPassword : null, username.trim());
      if (r.ok) {
        switchMode("signin");
        setInfo(r.password_changed
          ? "Password reset. Every device was signed out — sign in with your new password."
          : "Unlocked. Every device was signed out — sign in again.");
        return;
      }
      setBackupCode(""); setShowCode(false);   // a wrong code is not kept around; the new password stays for a retry
      setError(backupCodeError(r));
    } catch {
      setError(OFFLINE);
    } finally {
      setLoading(false);
    }
  }

  const labelStyle = { display: "block", fontSize: 11, color: "#94a3b8", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
  const canSubmit = !loading && (mode === "signin" ? (username.trim() && password)
    : mode === "join" ? (inviteCode.trim() && username.trim() && password && confirmPassword)
    : mode === "reset" ? (username.trim() && backupCode.trim() && newPassword && confirmPassword) : (username.trim() && backupCode.trim()));
  const buttonStyle = {
    width: "100%", padding: "14px", border: "none", borderRadius: 12,
    fontFamily: font, fontSize: 14, fontWeight: 700, letterSpacing: 0.5,
    cursor: canSubmit ? "pointer" : "not-allowed",
    background: canSubmit ? "linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa)" : "rgba(30,41,59,0.3)",
    color: "white",
    boxShadow: canSubmit ? "0 4px 20px rgba(99,102,241,0.35)" : "none",
    transition: "all 0.3s cubic-bezier(0.4,0,0.2,1)",
    marginTop: 4, minHeight: 44,
  };
  const linkStyle = { background: "transparent", border: "none", color: "#818cf8", fontFamily: font, fontSize: 12, cursor: "pointer", padding: "10px 4px", minHeight: 44 };
  const subtitle = joined ? "YOUR ACCOUNT IS READY" : mode === "signin" ? "PARALLEL AI GENERATION COCKPIT" : mode === "join" ? "JOIN WITH AN INVITE" : mode === "reset" ? "RESET PASSWORD WITH BACKUP CODE" : "UNLOCK WITH BACKUP CODE";
  const submitLabel = loading ? "CHECKING…" : mode === "signin" ? "SIGN IN" : mode === "join" ? "CREATE ACCOUNT" : mode === "reset" ? "RESET PASSWORD" : "UNLOCK";
  const canContinue = !!(savedCode && joined?.claimed);
  const continueStyle = { ...buttonStyle, cursor: canContinue ? "pointer" : "not-allowed",
    background: canContinue ? "linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa)" : "rgba(30,41,59,0.3)",
    boxShadow: canContinue ? "0 4px 20px rgba(99,102,241,0.35)" : "none" };

  return (
    <div style={{ width: "100%", height: "100vh", overflowY: "auto", display: "flex", padding: 20, boxSizing: "border-box" }}>
      <form onSubmit={joined ? (e => e.preventDefault()) : mode === "signin" ? handleSignIn : mode === "join" ? handleJoin : handleBackupCode} style={{
        margin: "auto",
        background: "rgba(8,12,25,0.6)",
        border: "1px solid rgba(99,102,241,0.2)",
        borderRadius: 18,
        padding: "36px 32px",
        width: "100%",
        maxWidth: 400,
        boxShadow: "0 10px 60px rgba(0,0,0,0.5), 0 0 60px rgba(99,102,241,0.12)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        fontFamily: fontBody,
        color: "#e2e8f0",
      }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 48, marginBottom: 10, color: "#a78bfa", filter: "drop-shadow(0 0 20px rgba(167,139,250,0.4))" }}>◈</div>
          <div style={{ fontFamily: font, fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: 1.5 }}>ProximaAI</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontFamily: font, letterSpacing: 0.5 }}>{subtitle}</div>
        </div>

        {joined ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={labelStyle}>Your backup code (shown once)</div>
              <div style={{ fontFamily: font, fontSize: 18, letterSpacing: 1, wordBreak: "break-all", userSelect: "all", padding: "12px 14px", border: "1px solid rgba(99,102,241,0.4)", borderRadius: 10, background: "rgba(15,23,42,0.6)", color: "#f1f5f9" }}>{joined.backupCode}</div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8, lineHeight: 1.5 }}>It unlocks your account if you forget your password or get locked out. Write it down or keep it in a password manager: it is not shown again.</div>
            </div>
            <button type="button" style={linkStyle} onClick={() => {
              if (!navigator.clipboard?.writeText) { setInfo(""); setError(COPY_BY_HAND); return; }
              navigator.clipboard.writeText(joined.backupCode).then(() => { setError(""); setInfo("Copied."); }, () => { setInfo(""); setError(COPY_BY_HAND); });
            }}>Copy code</button>
            {info && <div role="status" style={{ fontSize: 12, color: "#22c55e", fontFamily: font }}>✓ {info}</div>}
            {error && <div role="alert" style={{ fontSize: 12, color: "#ef4444", fontFamily: font }}>✗ {error}</div>}
            {!joined.claimed && <div role="alert" style={{ fontSize: 12, color: "#ef4444", fontFamily: font, lineHeight: 1.5 }}>✗ {browserAccountMessage({ reason: "claim-failed" })}</div>}
            <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, minHeight: 44, cursor: "pointer" }}>
              <input type="checkbox" checked={savedCode} onChange={e => setSavedCode(e.target.checked)} style={{ width: 20, height: 20 }} />
              I saved my backup code
            </label>
            <button type="button" disabled={!savedCode || !joined.claimed} style={continueStyle} onClick={() => { const s = joined.session; forgetJoinedNote(); setJoined(null); clearSecrets(); onSignedIn(s); }}>CONTINUE</button>
          </div>
        ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {mode === "join" ? (<>
            <div>
              <label htmlFor="join-code" style={labelStyle}>Invite code</label>
              <input id="join-code" type="text" value={inviteCode} onChange={e => { setInviteCode(e.target.value); setError(""); }}
                autoFocus autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
            <div>
              <label htmlFor="join-username" style={labelStyle}>Choose a username</label>
              <input id="join-username" type="text" value={username} onChange={e => { setUsername(e.target.value); setError(""); }}
                autoComplete="username" autoCapitalize="off" spellCheck={false} style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
            <div>
              <label htmlFor="join-password" style={labelStyle}>Choose a password (8+ characters)</label>
              <input id="join-password" type="password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                autoComplete="new-password" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
            <div>
              <label htmlFor="join-confirm" style={labelStyle}>Confirm password</label>
              <input id="join-confirm" type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }}
                autoComplete="new-password" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
          </>) : mode === "signin" ? (<>
            <div>
              <label htmlFor="login-username" style={labelStyle}>Username</label>
              <input id="login-username" type="text" value={username} onChange={e => { setUsername(e.target.value); setError(""); }}
                autoFocus autoComplete="username" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
            <div>
              <label htmlFor="login-password" style={labelStyle}>Password</label>
              <input id="login-password" type="password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                autoComplete="current-password" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
          </>) : (<>
            {(mode === "reset" || mode === "unlock") && (
              <div>
                <label htmlFor="login-reset-username" style={labelStyle}>Username</label>
                <input id="login-reset-username" type="text" value={username} onChange={e => { setUsername(e.target.value); setError(""); }}
                  autoComplete="username" autoCapitalize="off" spellCheck={false} style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
              </div>
            )}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label htmlFor="login-backup-code" style={{ ...labelStyle, marginBottom: 0 }}>Backup code</label>
                <button type="button" onClick={() => setShowCode(s => !s)} aria-pressed={showCode} aria-controls="login-backup-code"
                  style={{ ...linkStyle, padding: "0 4px", fontSize: 11, minWidth: 44 }}>{showCode ? "Hide" : "Show"}</button>
              </div>
              <input id="login-backup-code" type="text" value={backupCode} onChange={e => { setBackupCode(e.target.value); setError(""); }}
                autoFocus autoComplete="one-time-code" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                style={{ ...loginInputStyle, ...maskedCodeStyle(showCode) }} onFocus={loginFocus} onBlur={loginBlur} />
            </div>
            {mode === "reset" && (<>
              <div>
                <label htmlFor="login-new-password" style={labelStyle}>New password (8+ characters)</label>
                <input id="login-new-password" type="password" value={newPassword} onChange={e => { setNewPassword(e.target.value); setError(""); }}
                  autoComplete="new-password" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
              </div>
              <div>
                <label htmlFor="login-confirm-password" style={labelStyle}>Confirm new password</label>
                <input id="login-confirm-password" type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }}
                  autoComplete="new-password" style={loginInputStyle} onFocus={loginFocus} onBlur={loginBlur} />
              </div>
            </>)}
          </>)}
          {info && (
            <div role="status" style={{ fontSize: 12, color: "#22c55e", padding: "10px 14px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 10, fontFamily: font }}>
              ✓ {info}
            </div>
          )}
          {error && (
            <div role="alert" style={{ fontSize: 12, color: "#ef4444", padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, fontFamily: font }}>
              ✗ {error}
            </div>
          )}
          <button type="submit" disabled={!canSubmit} style={buttonStyle}>{submitLabel}</button>
          {mode === "signin" && (
            <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: font, textAlign: "center", lineHeight: 1.5 }}>{SIGNIN_HINT}</div>
          )}
          {mode === "signin" ? (<>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button type="button" style={linkStyle} onClick={() => switchMode("reset")}>Forgot password?</button>
              <button type="button" style={linkStyle} onClick={() => switchMode("unlock")}>Locked out?</button>
            </div>
            <button type="button" style={linkStyle} onClick={() => switchMode("join")}>Have an invite? Join</button>
          </>) : mode === "unlock" ? (
            // Locked out because the password is forgotten: the reset path must be one tap away from here.
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button type="button" style={linkStyle} onClick={() => switchMode("signin")}>← Sign in</button>
              <button type="button" style={linkStyle} onClick={() => switchMode("reset")}>Forgot password?</button>
            </div>
          ) : (
            <button type="button" style={linkStyle} onClick={() => switchMode("signin")}>← Back to sign in</button>
          )}
        </div>
        )}

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 10, color: "#64748b", fontFamily: font, letterSpacing: 0.5 }}>
          Cloud sync enabled · Works across all devices
        </div>
      </form>
    </div>
  );
}

const font = `'JetBrains Mono', 'Fira Code', monospace`;
const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

// ─── UPDATE BANNER ───
// Shown once a newer deployment is live (a long-open tab otherwise keeps running old code). Reloading is safe
// mid-generation: in-flight tasks resume from IndexedDB after the reload.
function UpdateBanner() {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div role="status" style={{
      position: "fixed", top: "calc(8px + env(safe-area-inset-top))", left: "50%", transform: "translateX(-50%)", zIndex: 3000,
      display: "flex", alignItems: "center", gap: 10, padding: "4px 4px 4px 14px", borderRadius: 999,
      maxWidth: "calc(100vw - 32px)", boxSizing: "border-box",
      background: "rgba(245,158,11,0.16)", border: "1px solid rgba(245,158,11,0.5)", color: "#fbbf24",
      fontFamily: font, fontSize: 12, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
    }}>
      <span style={{ whiteSpace: "nowrap" }}>New version ready</span>
      <button onClick={() => window.location.reload()} style={{
        minHeight: 44, minWidth: 80, padding: "0 16px", borderRadius: 999, border: "none", background: "#f59e0b",
        color: "#1a1204", fontFamily: font, fontWeight: 700, fontSize: 12, cursor: "pointer",
      }}>Reload</button>
    </div>
  );
}

// ─── SIDEBAR SAVE-STATUS BUTTON ───
// Lives in the nav bar. Tap to force-flush pending cloud writes.
// Long-press (600ms) to create a full manual cloud backup.
function SidebarSaveButton({ saveStatus, failedCount, onForceSave, onBackup }) {
  const effective = failedCount > 0 && saveStatus !== "saving" ? "error" : saveStatus;
  const cfg = {
    idle:   { icon: "✓", color: "#22c55e", bg: "transparent",             border: "transparent",                 pulse: false, label: "Saved · Long-press to backup" },
    saving: { icon: "⟳", color: "#6366f1", bg: "rgba(99,102,241,0.12)",   border: "rgba(99,102,241,0.35)",       pulse: true,  label: "Saving…" },
    saved:  { icon: "✓", color: "#22c55e", bg: "rgba(34,197,94,0.15)",    border: "rgba(34,197,94,0.4)",         pulse: false, label: "Saved!" },
    error:  { icon: "⚠", color: "#ef4444", bg: "rgba(239,68,68,0.12)",    border: "rgba(239,68,68,0.35)",        pulse: false, label: failedCount > 0 ? `Retry (${failedCount})` : "Retry" },
    backup: { icon: "☁", color: "#f59e0b", bg: "rgba(245,158,11,0.15)",   border: "rgba(245,158,11,0.4)",        pulse: true,  label: "Creating backup…" },
  }[effective] || { icon: "·", color: "#94a3b8", bg: "transparent", border: "transparent", pulse: false, label: "Idle" };

  const pressStartRef = useRef(0);
  const longPressTimerRef = useRef(null);
  const triggeredLongPressRef = useRef(false);

  const startPress = (e) => {
    e.preventDefault();
    triggeredLongPressRef.current = false;
    pressStartRef.current = Date.now();
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      triggeredLongPressRef.current = true;
      if (navigator.vibrate) navigator.vibrate(40);
      onBackup();
    }, 600);
  };
  const endPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (!triggeredLongPressRef.current) {
      // Short tap — force save
      if (Date.now() - pressStartRef.current < 600) onForceSave();
    }
  };
  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };

  return (
    <button
      className="sidebar-btn"
      title={cfg.label}
      onMouseDown={startPress}
      onMouseUp={endPress}
      onMouseLeave={cancelPress}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchCancel={cancelPress}
      onContextMenu={e => e.preventDefault()}
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: cfg.border !== "transparent" ? `1px solid ${cfg.border}` : "none",
        userSelect: "none", WebkitUserSelect: "none",
      }}>
      <span style={{ display: "inline-block", animation: cfg.pulse ? "spin 1.2s linear infinite" : "none" }}>{cfg.icon}</span>
    </button>
  );
}

// ─── FLOATING SAVE STATUS BUTTON (deprecated, replaced by SidebarSaveButton) ───
function FloatingSaveButton({ saveStatus, onForceSave, failedCount = 0 }) {
  // Honest status: if there are unreplayed failures, we're NEVER truly "saved"
  const effective = failedCount > 0 && saveStatus !== "saving" ? "error" : saveStatus;
  const cfg = {
    idle:   { icon: "✓", label: "Saved",                              bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.35)",  color: "#22c55e", pulse: false },
    saving: { icon: "⟳", label: "Saving…",                            bg: "rgba(99,102,241,0.15)", border: "rgba(99,102,241,0.4)",  color: "#6366f1", pulse: true  },
    saved:  { icon: "✓", label: "Saved!",                             bg: "rgba(34,197,94,0.2)",   border: "rgba(34,197,94,0.5)",   color: "#22c55e", pulse: false },
    error:  { icon: "⚠", label: failedCount > 0 ? `Retry (${failedCount})` : "Retry",  bg: "rgba(239,68,68,0.15)",  border: "rgba(239,68,68,0.4)",   color: "#ef4444", pulse: false },
  }[effective] || { icon: "·", label: "Idle", bg: "rgba(30,41,59,0.3)", border: "rgba(99,102,241,0.2)", color: "#94a3b8", pulse: false };

  return (
    <button onClick={onForceSave} title="Click to save immediately"
      style={{
        position: "fixed", left: "calc(14px + env(safe-area-inset-left))",
        bottom: "calc(14px + env(safe-area-inset-bottom))",
        zIndex: 1500, display: "flex", alignItems: "center", gap: 8,
        padding: "8px 14px", borderRadius: 999,
        background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
        fontFamily: font, fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
        cursor: "pointer", transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
      }}>
      <span style={{ fontSize: 14, display: "inline-block",
        animation: cfg.pulse ? "spin 1.2s linear infinite" : "none" }}>{cfg.icon}</span>
      <span>{cfg.label}</span>
    </button>
  );
}

// ─── ACCOUNT MANAGEMENT MODAL ───
// Server answers for the password-checked account RPCs, in words: accountError in src/lib/signinText.js.

// 20 random characters from a 32-symbol alphabet (no 0/O/1/I), grouped for writing down: ~100 bits.
function makeBackupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(20)), b => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

function AccountModal({ onClose, onSaved, onPasswordReset }) {
  // Steps: load → menu → set-email → verify-email → change-username → change-password → change-email-verify-new → done
  const [step, setStep] = useState("load");
  const [creds, setCreds] = useState(null);
  const [email, setEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(""); // "username" | "password" | "email"
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState("");
  const [backupCode, setBackupCodeInput] = useState("");
  const [confirmBackupCode, setConfirmBackupCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [showResetCode, setShowResetCode] = useState(false);
  const saveAccount = (fields) => setMyAccount(fields).catch(() => false);

  useEffect(() => {
    (async () => {
      try {
        const a = await getMyAccount();
        if (!a?.ok) throw new Error("Couldn't load the account");
        setCreds({ username: a.username, email: a.email || "", email_verified: a.email_verified ? "true" : "false",
          last_verified_at: String(a.last_verified_at || 0), has_backup_code: !!a.has_backup_code });
        setEmail(a.email || "");
      } catch (err) { setCreds({}); setError(err.message || "Couldn't load the account"); }
      setStep("menu");
    })();
  }, []);

  async function doSendOtp(toEmail) {
    setBusy(true); setError("");
    const r = await sendEmailOtp(toEmail);
    setBusy(false);
    if (!r.ok) { setError(r.error || "Failed to send code"); return false; }
    setPendingVerifyEmail(toEmail);
    return true;
  }

  async function startAction(kind) {
    setError("");
    setAction(kind);
    if (!creds?.email || creds?.email_verified !== "true") {
      setStep("set-email");
      return;
    }
    // Skip re-verification if user verified within the last 10 minutes
    const lastVerified = parseInt(creds?.last_verified_at || "0", 10);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    if (lastVerified > tenMinAgo) {
      if (kind === "username") setStep("change-username");
      else if (kind === "password") setStep("change-password");
      else if (kind === "email") setStep("change-email-new");
      return;
    }
    // Send OTP to existing email
    const ok = await doSendOtp(creds.email);
    if (ok) setStep("verify-otp");
  }

  async function submitSetEmail(e) {
    e.preventDefault();
    if (!email.includes("@")) { setError("Enter a valid email"); return; }
    const ok = await doSendOtp(email);
    if (ok) setStep("verify-otp");
  }

  async function submitVerifyOtp(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await verifyEmailOtp(pendingVerifyEmail, otp.trim());
    setBusy(false);
    if (!r.ok) { setError(r.error || "Invalid code"); return; }
    const now = String(Date.now());
    // First-time email setup: save email as verified and finish
    if (!creds?.email || creds.email !== pendingVerifyEmail) {
      await saveAccount({ email: pendingVerifyEmail, emailVerified: true, lastVerifiedAt: now });
      setCreds(c => ({ ...c, email: pendingVerifyEmail, email_verified: "true", last_verified_at: now }));
    } else {
      await saveAccount({ emailVerified: true, lastVerifiedAt: now });
      setCreds(c => ({ ...c, last_verified_at: now }));
    }
    // Route to the action they wanted
    if (action === "username") setStep("change-username");
    else if (action === "password") setStep("change-password");
    else if (action === "email") setStep("change-email-new");
    else setStep("menu");
    setOtp("");
  }

  async function submitNewUsername(e) {
    e.preventDefault();
    const name = newUsername.trim();
    if (name.length < 2) { setError("Username must be at least 2 characters"); return; }
    if (!currentPassword) { setError("Enter your current password"); return; }
    setBusy(true); setError("");
    try {
      const r = await renameMyAccount(currentPassword, name);
      if (!r?.ok) { setError(accountError(r, "Failed to save. Try again.")); return; }
      // The server moved every row to the new name and issued a token for it; reload so all
      // scope-bound state (realtime filter, favorites key, queues) starts over under the new scope.
      setSession({ token: r.token, expires_at: r.expires_at, username: r.username });
      const rec = readBrowserAccount();
      if (rec?.id && rec.id === tokenAccountId(r.token)) claimBrowser({ ...rec, username: r.username });   // review r6 #13
      resetDeviceIdCache();
      setStep("done");
      onSaved?.("Username changed — reloading");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) { setError(err.message || "Failed to save. Try again."); }
    finally { setBusy(false); setCurrentPassword(""); }
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    if (!currentPassword) { setError("Enter your current password"); return; }
    if (newPassword.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setBusy(true); setError("");
    try {
      const r = await changeMyPassword(currentPassword, newPassword);
      if (!r?.ok) { setError(accountError(r, "Failed to save. Try again.")); return; }
      // Every other device is signed out by the change; this one continues on the fresh token.
      setSession({ token: r.token, expires_at: r.expires_at, username: r.username });
      setNewPassword(""); setConfirmPassword("");
      setStep("done");
      onSaved?.("Password changed — your other devices were signed out");
    } catch (err) { setError(err.message || "Failed to save. Try again."); }
    finally { setBusy(false); setCurrentPassword(""); }
  }

  async function submitBackupCode(e) {
    e.preventDefault();
    const code = backupCode.trim();
    if (!currentPassword) { setError("Enter your current password"); return; }
    if (code.length < 12) { setError("Backup code must be at least 12 characters"); return; }
    if (code !== confirmBackupCode.trim()) { setError("Backup codes don't match"); return; }
    setBusy(true); setError("");
    try {
      const r = await setBackupCode(currentPassword, code);
      if (!r?.ok) { setError(accountError(r, "Failed to save. Try again.")); return; }
      setBackupCodeInput(""); setConfirmBackupCode("");
      setCreds(c => ({ ...c, has_backup_code: true }));
      setStep("done");
      onSaved?.("Backup code saved — keep your written copy safe");
    } catch (err) { setError(err.message || "Failed to save. Try again."); }
    finally { setBusy(false); setCurrentPassword(""); }
  }

  // Forgot the password while still signed in here: the backup code sets a new one. The server then signs out every
  // device (this one too), so the app returns to the sign-in screen.
  async function submitResetWithCode(e) {
    e.preventDefault();
    const code = resetCode.trim();
    if (!code) { setError("Enter your backup code"); return; }
    if (newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("New passwords don't match"); return; }
    if (!creds?.username) { setError("Couldn't load your account name. Close Account and open it again."); return; }
    setBusy(true); setError("");
    try {
      const r = await unlockWithBackupCode(code, newPassword, creds.username);
      if (!r?.ok) { setResetCode(""); setShowResetCode(false); setError(backupCodeError(r)); return; }
      setResetCode(""); setNewPassword(""); setConfirmPassword("");
      onPasswordReset?.();
    } catch { setError("Can't reach the server — check your connection and try again."); }
    finally { setBusy(false); }
  }

  async function submitNewEmail(e) {
    e.preventDefault();
    if (!newEmail.includes("@")) { setError("Enter a valid email"); return; }
    // Send OTP to the NEW email to verify ownership
    const ok = await doSendOtp(newEmail);
    if (ok) setStep("verify-new-email");
  }

  async function submitVerifyNewEmail(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await verifyEmailOtp(pendingVerifyEmail, otp.trim());
    if (!r.ok) { setBusy(false); setError(r.error || "Invalid code"); return; }
    const ok = await saveAccount({ email: pendingVerifyEmail, emailVerified: true });
    setBusy(false);
    if (!ok) { setError("Failed to save"); return; }
    setStep("done");
    onSaved?.("Email changed");
  }

  const box = {
    background: "rgba(8,12,25,0.95)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 16,
    padding: "28px 26px", width: "100%", maxWidth: 440, color: "#e2e8f0", fontFamily: fontBody,
    boxShadow: "0 20px 80px rgba(0,0,0,0.6), 0 0 80px rgba(99,102,241,0.15)",
    backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
  };
  const input = {
    width: "100%", background: "rgba(10,20,40,0.5)", border: "1px solid rgba(99,102,241,0.2)",
    borderRadius: 10, padding: "12px 14px", color: "#f1f5f9", fontFamily: font, fontSize: 15,
    outline: "none", boxSizing: "border-box",
  };
  const btn = (variant) => ({
    padding: "12px 20px", borderRadius: 10, fontFamily: font, fontSize: 13, fontWeight: 700,
    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1, letterSpacing: 0.5,
    background: variant === "primary" ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "rgba(30,41,59,0.5)",
    color: variant === "primary" ? "white" : "#e2e8f0",
    border: variant === "primary" ? "none" : "1px solid rgba(99,102,241,0.2)",
    transition: "all 0.2s",
  });
  const label = { fontSize: 11, color: "#94a3b8", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block" };
  const title = { fontFamily: font, fontSize: 16, fontWeight: 700, marginBottom: 6, color: "#f1f5f9" };
  const subtitle = { fontSize: 12, color: "#94a3b8", marginBottom: 20, lineHeight: 1.5 };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(2,5,16,0.85)", backdropFilter: "blur(8px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={box}>
        {step === "load" && <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>Loading...</div>}

        {step === "menu" && (
          <>
            <div style={title}>Account Settings</div>
            <div style={subtitle}>
              Signed in as <b style={{ color: "#e2e8f0" }}>{creds?.username || "admin"}</b>
              {creds?.email && <><br/>Email: <span style={{ color: "#e2e8f0" }}>{creds.email}</span> {creds.email_verified === "true" ? "✓" : <span style={{ color: "#f59e0b" }}>(unverified)</span>}</>}
              {!creds?.email && <><br/><span style={{ color: "#f59e0b" }}>No email set — add one for account recovery</span></>}
              {creds && creds.has_backup_code === false && <><br/><span style={{ color: "#f59e0b" }}>No backup code — set one so a sign-in lockout can be undone</span></>}
              {(() => {
                const lv = parseInt(creds?.last_verified_at || "0", 10);
                if (lv > Date.now() - 10 * 60 * 1000) {
                  const mins = Math.max(1, Math.ceil((lv + 10 * 60 * 1000 - Date.now()) / 60000));
                  return <><br/><span style={{ color: "#22c55e", fontSize: 11 }}>✓ Recently verified · skip re-verify for {mins} more min</span></>;
                }
                return null;
              })()}
            </div>
            {busy && <div style={{ color: "#6366f1", fontSize: 12, marginBottom: 10, textAlign: "center" }}>Sending verification code to your email...</div>}
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 10, padding: "10px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8 }}>✗ {error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button disabled={busy} style={btn()} onClick={() => startAction("username")}>Change Username</button>
              <button disabled={busy} style={btn()} onClick={() => startAction("password")}>Change Password</button>
              <button disabled={busy} style={btn()} onClick={() => startAction("email")}>{creds?.email ? "Change Email" : "Set Email"}</button>
              <button disabled={busy} style={btn()} onClick={() => { setError(""); setCurrentPassword(""); setStep("set-backup"); }}>{creds?.has_backup_code ? "Replace Backup Code" : "Set Backup Code"}</button>
              {creds?.has_backup_code && <button disabled={busy} style={btn()} onClick={() => { setError(""); setResetCode(""); setShowResetCode(false); setNewPassword(""); setConfirmPassword(""); setStep("reset-with-code"); }}>Forgot Password? Use Backup Code</button>}
              <button style={{ ...btn(), marginTop: 8, background: "transparent" }} onClick={onClose}>Close</button>
            </div>
            <div style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", textAlign: "center", fontSize: 11, color: "#64748b", letterSpacing: 0.4 }}>
              Built by{" "}
              <a
                href="https://accessoryseezin.com"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#818cf8", textDecoration: "none", fontWeight: 600 }}
              >
                AccessorySeezin.com
              </a>
            </div>
          </>
        )}

        {step === "set-email" && (
          <form onSubmit={submitSetEmail}>
            <div style={title}>Verify Your Email</div>
            <div style={subtitle}>We'll send a 6-digit code to confirm it's really you before making account changes.</div>
            <label htmlFor="acct-email-address" style={label}>Email Address</label>
            <input id="acct-email-address" type="email" value={email} onChange={e => { setEmail(e.target.value); setError(""); }} style={input} placeholder="you@example.com" autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Back</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Sending..." : "Send Code"}</button>
            </div>
          </form>
        )}

        {step === "verify-otp" && (
          <form onSubmit={submitVerifyOtp}>
            <div style={title}>Enter Verification Code</div>
            <div style={subtitle}>Sent to <b style={{ color: "#e2e8f0" }}>{pendingVerifyEmail}</b>. Check spam if you don't see it.</div>
            <label htmlFor="acct-verification-code" style={label}>Verification Code</label>
            <input id="acct-verification-code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code"
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 10)); setError(""); }}
              onPaste={e => { e.preventDefault(); const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 10); setOtp(t); }}
              style={{ ...input, letterSpacing: 6, textAlign: "center", fontSize: 22 }} maxLength={10} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy || otp.length < 6} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Verifying..." : "Verify"}</button>
            </div>
            <button type="button" onClick={() => doSendOtp(pendingVerifyEmail)} style={{ marginTop: 12, background: "transparent", border: "none", color: "#6366f1", fontSize: 12, cursor: "pointer", fontFamily: font }}>Resend code</button>
          </form>
        )}

        {step === "change-username" && (
          <form onSubmit={submitNewUsername}>
            <div style={title}>New Username</div>
            <div style={subtitle}>Current: <b>{creds?.username || "admin"}</b>. Your data moves to the new name.</div>
            <label htmlFor="acct-current-password" style={label}>Current Password</label>
            <input id="acct-current-password" type="password" value={currentPassword} onChange={e => { setCurrentPassword(e.target.value); setError(""); }} style={input} autoComplete="current-password" autoFocus />
            <label htmlFor="acct-new-username" style={{ ...label, marginTop: 12 }}>New Username</label>
            <input id="acct-new-username" type="text" value={newUsername} onChange={e => { setNewUsername(e.target.value); setError(""); }} style={input} autoComplete="username" />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Saving..." : "Save"}</button>
            </div>
          </form>
        )}

        {step === "change-password" && (
          <form onSubmit={submitNewPassword}>
            <div style={title}>New Password</div>
            <div style={subtitle}>Minimum 8 characters.</div>
            <label htmlFor="acct-current-password" style={label}>Current Password</label>
            <input id="acct-current-password" type="password" value={currentPassword} onChange={e => { setCurrentPassword(e.target.value); setError(""); }} style={input} autoComplete="current-password" autoFocus />
            <label htmlFor="acct-new-password" style={{ ...label, marginTop: 12 }}>New Password</label>
            <input id="acct-new-password" type="password" value={newPassword} onChange={e => { setNewPassword(e.target.value); setError(""); }} style={input} autoComplete="new-password" />
            <label htmlFor="acct-confirm-password" style={{ ...label, marginTop: 12 }}>Confirm Password</label>
            <input id="acct-confirm-password" type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }} style={input} autoComplete="new-password" />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Saving..." : "Save"}</button>
            </div>
          </form>
        )}

        {step === "reset-with-code" && (
          <form onSubmit={submitResetWithCode}>
            <div style={title}>Reset Password</div>
            <div style={subtitle}>For a forgotten password. Your backup code sets a new one and signs out every device, this one included.</div>
            <input type="text" name="username" autoComplete="username" value={creds?.username || ""} readOnly tabIndex={-1} aria-hidden="true" style={visuallyHidden} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label htmlFor="acct-reset-code" style={{ ...label, marginBottom: 0 }}>Backup Code</label>
              <button type="button" onClick={() => setShowResetCode(v => !v)} aria-pressed={showResetCode} aria-controls="acct-reset-code"
                style={{ background: "transparent", border: "none", color: "#818cf8", fontFamily: font, fontSize: 11, cursor: "pointer", minHeight: 44, minWidth: 44, padding: "0 4px" }}>{showResetCode ? "Hide" : "Show"}</button>
            </div>
            <input id="acct-reset-code" type="text" value={resetCode} onChange={e => { setResetCode(e.target.value); setError(""); }}
              style={{ ...input, ...maskedCodeStyle(showResetCode) }} autoComplete="one-time-code" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus />
            <label htmlFor="acct-reset-new-password" style={{ ...label, marginTop: 12 }}>New Password (8+ characters)</label>
            <input id="acct-reset-new-password" type="password" value={newPassword} onChange={e => { setNewPassword(e.target.value); setError(""); }} style={input} autoComplete="new-password" />
            <label htmlFor="acct-reset-confirm-password" style={{ ...label, marginTop: 12 }}>Confirm New Password</label>
            <input id="acct-reset-confirm-password" type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }} style={input} autoComplete="new-password" />
            {error && <div role="alert" style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => { setResetCode(""); setShowResetCode(false); setNewPassword(""); setConfirmPassword(""); setError(""); setStep("menu"); }}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Resetting..." : "Reset Password"}</button>
            </div>
          </form>
        )}

        {step === "set-backup" && (
          <form onSubmit={submitBackupCode}>
            <div style={title}>Backup Code</div>
            <div style={subtitle}>Unlocks sign-in after 3 failed attempts, and can set a new password if you forget it. Write it down and keep it somewhere safe: the server stores only a hash, so it can't be shown again.</div>
            <label htmlFor="acct-current-password" style={label}>Current Password</label>
            <input id="acct-current-password" type="password" value={currentPassword} onChange={e => { setCurrentPassword(e.target.value); setError(""); }} style={input} autoComplete="current-password" autoFocus />
            <label htmlFor="acct-backup-code" style={{ ...label, marginTop: 12 }}>Backup Code (12+ characters)</label>
            {/* Full-width field: a generated code (24 chars) must be readable in full at 384px to be written down */}
            <input id="acct-backup-code" type="text" value={backupCode} onChange={e => { setBackupCodeInput(e.target.value); setError(""); }} style={input} autoComplete="off" spellCheck={false} />
            <button type="button" style={{ ...btn(), width: "100%", marginTop: 8, minHeight: 44 }} onClick={() => { const c = makeBackupCode(); setBackupCodeInput(c); setConfirmBackupCode(""); setError(""); }}>Generate a strong code</button>
            <label htmlFor="acct-type-it-again" style={{ ...label, marginTop: 12 }}>Type It Again</label>
            <input id="acct-type-it-again" type="text" value={confirmBackupCode} onChange={e => { setConfirmBackupCode(e.target.value); setError(""); }} style={input} autoComplete="off" spellCheck={false} />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Saving..." : "Save"}</button>
            </div>
          </form>
        )}

        {step === "change-email-new" && (
          <form onSubmit={submitNewEmail}>
            <div style={title}>New Email</div>
            <div style={subtitle}>We'll send a verification code to the new address.</div>
            <label htmlFor="acct-new-email-address" style={label}>New Email Address</label>
            <input id="acct-new-email-address" type="email" value={newEmail} onChange={e => { setNewEmail(e.target.value); setError(""); }} style={input} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Sending..." : "Send Code"}</button>
            </div>
          </form>
        )}

        {step === "verify-new-email" && (
          <form onSubmit={submitVerifyNewEmail}>
            <div style={title}>Confirm New Email</div>
            <div style={subtitle}>Code sent to <b style={{ color: "#e2e8f0" }}>{pendingVerifyEmail}</b></div>
            <label htmlFor="acct-verification-code" style={label}>Verification Code</label>
            <input id="acct-verification-code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code"
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 10)); setError(""); }}
              onPaste={e => { e.preventDefault(); const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 10); setOtp(t); }}
              style={{ ...input, letterSpacing: 6, textAlign: "center", fontSize: 22 }} maxLength={10} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy || otp.length < 6} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Verifying..." : "Verify & Save"}</button>
            </div>
          </form>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 48, color: "#22c55e", marginBottom: 12 }}>✓</div>
            <div style={title}>Saved!</div>
            <div style={subtitle}>Your changes are synced to the cloud and available on all your devices.</div>
            <button style={btn("primary")} onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── STYLES ───

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-deep: #020510; --bg-card: rgba(12,18,35,0.08); --bg-hover: rgba(30,41,59,0.08); --bg-input: rgba(10,20,40,0.1);
  --border: rgba(56,68,100,0.15); --border-focus: #6366f1;
  --text-primary: #e2e8f0; --text-secondary: #94a3b8; --text-muted: #64748b;
  --accent: #6366f1; --accent-glow: rgba(99,102,241,0.15);
  --success: #22c55e; --warning: #f59e0b; --error: #ef4444;
  --amber: #f59e0b; --amber-glow: rgba(245,158,11,0.08);
  --glass: rgba(10,15,30,0.07); --glass-border: rgba(99,102,241,0.08);
}

html { background: var(--bg-deep); }
body { background: transparent; color: var(--text-primary); font-family: ${fontBody}; }

/* App shell — MUST be transparent so the fixed BackgroundLayer (z-index:0)
   renders through. The body background acts as the base color fallback. */
.proxima-app { display: flex; height: 100vh; overflow: hidden; position: relative; background: transparent; z-index: 1; }

.proxima-app > * { position: relative; z-index: 1; }

.sidebar { width: 56px; background: var(--nav-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; flex-shrink: 0; }
.sidebar-btn { width: 40px; height: 40px; border: none; background: transparent; color: var(--text-muted); border-radius: 10px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.sidebar-btn:hover { background: rgba(99,102,241,0.1); color: var(--text-primary); transform: scale(1.1); }
.sidebar-btn:active { transform: scale(0.95); }
.sidebar-btn.active { background: rgba(99,102,241,0.15); color: var(--accent); border: 1px solid rgba(99,102,241,0.3); box-shadow: 0 0 12px rgba(99,102,241,0.2); }
.sidebar-logo { font-size: 22px; margin-bottom: 16px; cursor: default; }
/* Push save button to bottom of vertical sidebar on desktop */
.sidebar-save-wrap { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--glass-border); width: 100%; display: flex; justify-content: center; }
@media (max-width: 768px) {
  /* On mobile (horizontal sidebar) don't push to an "end" — just sit inline */
  .sidebar-save-wrap { margin-top: 0; margin-left: auto; padding-top: 0; border-top: none; border-left: 1px solid var(--glass-border); padding-left: 6px; margin-left: 6px; width: auto; }
}

.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; position: relative; z-index: 1; }
.topbar { height: 48px; border-bottom: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; flex-shrink: 0; background: var(--nav-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); position: relative; z-index: 10; }
.topbar-title { font-family: ${font}; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-secondary); }
.balance-pill { font-family: ${font}; font-size: 12px; color: var(--success); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); padding: 4px 10px; border-radius: 20px; }

.content { flex: 1; overflow-y: auto; padding: 20px; min-width: 0; max-width: 100%; }

/* Cockpit */
.cockpit { display: grid; grid-template-columns: 420px minmax(0, 1fr); gap: 24px; height: 100%; min-height: 0; }
.cockpit-left { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; overflow-x: hidden; padding-right: 8px; padding-bottom: 60px; flex-shrink: 0; min-height: 0; scrollbar-gutter: stable; }
.cockpit-left::-webkit-scrollbar { width: 8px; }
.cockpit-left::-webkit-scrollbar-track { background: rgba(10,20,40,0.2); border-radius: 4px; }
.cockpit-left::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 4px; }
.cockpit-left::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.5); }
.cockpit-right { overflow-y: auto; min-width: 0; min-height: 0; padding-bottom: 40px; }
@media (min-width: 1600px) {
  .cockpit { grid-template-columns: 460px minmax(0, 1fr); gap: 28px; }
}
@media (max-width: 1200px) {
  .cockpit { grid-template-columns: 380px minmax(0, 1fr); gap: 20px; }
}

.card { background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: 14px; padding: 16px; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.card:hover { border-color: rgba(99,102,241,0.25); box-shadow: 0 4px 24px rgba(99,102,241,0.06); }
.card-title { font-family: ${font}; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }

.type-tabs-wrap { position: relative; flex-shrink: 0; }
.type-tabs-wrap::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 28px; pointer-events: none; background: linear-gradient(to right, transparent, rgba(5,8,22,0.6)); border-radius: 0 12px 12px 0; opacity: 0; transition: opacity 0.2s; }
.type-tabs-wrap.has-overflow::after { opacity: 1; }
.type-tabs { display: flex; gap: 4px; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 12px; padding: 3px; overflow-x: auto; overflow-y: hidden; flex-wrap: nowrap; scroll-behavior: smooth; -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.type-tabs::-webkit-scrollbar { height: 4px; }
.type-tabs::-webkit-scrollbar-track { background: transparent; }
.type-tabs::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.25); border-radius: 2px; }
.type-tabs::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.4); }
.type-tab { flex: 0 0 auto; padding: 9px 14px; min-width: 110px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-family: ${fontBody}; font-weight: 500; border-radius: 9px; cursor: pointer; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); white-space: nowrap; text-align: center; scroll-snap-align: start; }
.tab-label-full { display: inline; }
.tab-label-short { display: none; }
.tab-icon { display: none; }
.type-tab:hover { color: var(--text-secondary); background: rgba(99,102,241,0.08); }
.type-tab:active { transform: scale(0.97); }
.type-tab.active { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.3); }

.prompt-area { width: 100%; min-height: 90px; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 10px; padding: 12px; color: var(--text-primary); font-family: ${fontBody}; font-size: 14px; resize: vertical; outline: none; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.prompt-area:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.08); }
.prompt-area::placeholder { color: var(--text-muted); }

.model-selector-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.model-actions { display: flex; align-items: center; gap: 6px; }
.model-action-btn { min-height: 30px; padding: 4px 9px; border-radius: 7px; border: 1px solid rgba(99,102,241,0.3); background: transparent; color: var(--accent); font-family: ${font}; font-size: 10px; font-weight: 700; line-height: 1; cursor: pointer; transition: all 0.2s; }
.model-action-btn:hover:not(:disabled) { background: rgba(99,102,241,0.15); }
.model-action-btn.favorites { border-color: rgba(245,158,11,0.35); color: var(--warning); }
.model-action-btn.favorites:hover:not(:disabled), .model-action-btn.favorites.active { background: rgba(245,158,11,0.12); box-shadow: 0 0 10px rgba(245,158,11,0.08); }
.model-action-btn.clear { border-color: rgba(239,68,68,0.3); color: var(--error); }
.model-action-btn.clear:hover:not(:disabled) { background: rgba(239,68,68,0.1); }
.model-action-btn:disabled { cursor: default; opacity: 0.4; }
.model-grid { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; overflow-x: hidden; }
.model-item { display: grid; grid-template-columns: minmax(0, 1fr) 36px; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 8px; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); border: 1px solid transparent; }
.model-item:hover { background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.1); }
.model-item.selected { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.25); box-shadow: 0 0 12px rgba(99,102,241,0.08); }
.model-choice { min-width: 0; width: 100%; min-height: 38px; display: grid; grid-template-columns: 24px minmax(0, 1fr); grid-template-rows: auto auto; align-items: center; column-gap: 0; row-gap: 3px; padding: 4px 0; border: 0; background: transparent; color: inherit; font-family: ${fontBody}; text-align: left; cursor: pointer; }
.model-choice:active { transform: scale(0.99); }
.model-check { grid-column: 1; grid-row: 1 / span 2; width: 16px; height: 16px; margin-right: 8px; border-radius: 4px; border: 2px solid var(--text-muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); font-size: 10px; }
.model-item.selected .model-check { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: #6366f1; color: white; box-shadow: 0 0 8px rgba(99,102,241,0.4); }
.model-name { grid-column: 2; grid-row: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.3; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }
.model-provider { font-size: 10px; font-family: ${font}; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
.hot-badge { font-size: 9px; background: var(--error); color: white; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-family: ${font}; }
.model-price { margin-left: auto; font-size: 11px; font-family: ${font}; color: var(--text-muted); }
.model-meta { grid-column: 2; grid-row: 2; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.model-favorite-btn { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-muted); font-size: 20px; line-height: 1; cursor: pointer; transition: color 0.2s, background 0.2s, border-color 0.2s, transform 0.2s; }
.model-favorite-btn:hover { color: var(--warning); background: rgba(245,158,11,0.1); border-color: rgba(245,158,11,0.2); }
.model-favorite-btn:active { transform: scale(0.9); }
.model-favorite-btn.active { color: var(--warning); text-shadow: 0 0 10px rgba(245,158,11,0.45); }
.model-choice:focus-visible, .model-favorite-btn:focus-visible, .model-action-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settings-row label { font-size: 11px; color: var(--text-muted); font-weight: 500; }
.settings-select, .settings-input { background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 6px; padding: 6px 8px; color: var(--text-primary); font-size: 12px; font-family: ${font}; outline: none; min-width: 70px; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.settings-select { color-scheme: inherit; }
.settings-select option, .settings-select optgroup { background-color: var(--surface, var(--bg-deep)); color: var(--text-primary); }
.settings-select:focus, .settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }

.action-panel { display: flex; flex-direction: column; gap: 10px; }
.gen-btn { width: 100%; padding: 12px; border: none; border-radius: 12px; font-family: ${font}; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.35s cubic-bezier(0.4,0,0.2,1); letter-spacing: 0.5px; position: relative; overflow: hidden; }
.gen-btn.ready { background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.25); }
.gen-btn.ready:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(99,102,241,0.4); }
.gen-btn.ready:active { transform: translateY(0) scale(0.98); }
.gen-btn.running { background: rgba(30,41,59,0.3); color: var(--warning); cursor: pointer; }
.gen-btn.running:hover { transform: translateY(-2px); box-shadow: 0 6px 24px var(--accent-glow); }
.gen-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.cost-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--amber-glow); border: 1px solid rgba(245,158,11,0.2); border-radius: 8px; font-size: 12px; }
.cost-bar .cost-amount { font-family: ${font}; color: var(--amber); font-weight: 600; }

/* Progress + Results */
.task-card { min-width: 0; overflow: hidden; background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: 14px; padding: 14px; margin-bottom: 12px; transition: border-color 0.3s; animation: fadeSlideIn 0.4s ease; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.task-card:hover { border-color: rgba(99,102,241,0.2); }
.task-card.card-selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent), 0 0 18px rgba(99,102,241,0.25); }
.task-card.card-unselectable { opacity: 0.55; }
.select-check { position: absolute; top: 10px; left: 10px; width: 28px; height: 28px; border-radius: 8px; border: 2px solid var(--accent); background: rgba(99,102,241,0.22); color: white; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; z-index: 5; pointer-events: none; box-shadow: 0 1px 6px rgba(0,0,0,0.35); }
.select-check.on { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: #6366f1; box-shadow: 0 0 10px rgba(99,102,241,0.5); }
/* In select mode, push card content right so the top-left checkbox never overlaps the model name. */
.task-card.selecting-card .task-header { padding-left: 38px; }
/* Log-row selection: smaller, vertically-centered checkbox + selected-row highlight. */
.select-check.log-check { top: 50%; transform: translateY(-50%); left: 12px; width: 20px; height: 20px; font-size: 12px; border-radius: 5px; }
.log-row.log-row-selected { background: rgba(99,102,241,0.14); }
/* ── Bulk-select toolbar ── */
.sel-bar-launch { display: flex; justify-content: flex-end; margin-bottom: 10px; }
.sel-bar { margin-bottom: 10px; padding: 10px; background: rgba(8,12,25,0.5); border: 1px solid var(--glass-border); border-radius: 10px; }
.sel-bar-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.sel-count { font-family: ${font}; font-size: 13px; color: var(--text-primary); font-weight: 700; }
.sel-actions { display: flex; gap: 6px; }
.sel-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sel-chip, .sel-del, .sel-cancel, .sel-launch { font-family: ${font}; font-size: 11px; font-weight: 600; border-radius: 8px; padding: 7px 11px; border: 1px solid var(--glass-border); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; transition: all 0.2s; white-space: nowrap; }
.sel-chip:hover, .sel-cancel:hover, .sel-launch:hover { background: rgba(99,102,241,0.12); color: var(--text-primary); }
.sel-launch { color: var(--accent); border-color: rgba(99,102,241,0.3); }
.sel-chip-amber { color: var(--amber); border-color: rgba(245,158,11,0.3); }
.sel-del { color: #fff; background: var(--error); border-color: var(--error); }
.sel-del:disabled { background: rgba(239,68,68,0.35); cursor: default; opacity: 0.7; }
@media (max-width: 768px) {
  .sel-actions { width: 100%; }
  .sel-del { flex: 1; min-height: 44px; padding: 11px 14px; font-size: 13px; }
  .sel-cancel { min-height: 44px; padding: 11px 16px; font-size: 13px; }
  .sel-chip, .sel-launch { min-height: 42px; padding: 10px 13px; font-size: 12px; }
}
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-model { font-size: 13px; font-weight: 600; }
.task-batch-index { margin-left: 6px; font-family: ${font}; font-size: 11px; color: var(--text-muted); }
.task-status { font-size: 11px; font-family: ${font}; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
.task-status.pending { background: rgba(148,163,184,0.1); color: var(--text-muted); }
.task-status.processing { background: rgba(99,102,241,0.1); color: var(--accent); }
.task-status.completed { background: rgba(34,197,94,0.1); color: var(--success); }
.task-status.failed { background: rgba(239,68,68,0.1); color: var(--error); }
.task-timer { font-family: ${font}; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.task-progress { height: 3px; background: var(--bg-input); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.task-progress-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa); border-radius: 2px; transition: width 0.5s ease; box-shadow: 0 0 8px rgba(99,102,241,0.4); }

.result-img { width: 100%; border-radius: 8px; margin-top: 10px; cursor: pointer; transition: transform 0.2s; max-height: 300px; object-fit: cover; }
.result-img:hover { transform: scale(1.01); }
.result-video { width: 100%; border-radius: 8px; margin-top: 10px; max-height: 300px; }
.result-actions { display: grid; gap: 6px; margin-top: 8px; width: 100%; }
.result-actions-6 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.result-actions-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.result-actions-1 { grid-template-columns: 1fr; }
.result-action-btn { min-width: 0; width: 100%; min-height: 38px; display: flex; align-items: center; justify-content: center; padding: 5px 4px; font-size: 11px; line-height: 1.15; text-align: center; overflow-wrap: anywhere; border-radius: 6px; border: 1px solid var(--glass-border); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; font-family: ${font}; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
.result-action-btn:hover { background: rgba(99,102,241,0.12); color: var(--text-primary); border-color: rgba(99,102,241,0.4); box-shadow: 0 2px 10px rgba(99,102,241,0.15); }
.result-action-btn:active { transform: scale(0.96); }

.results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
@media (min-width: 1600px) {
  .results-grid { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
}

/* Logs */
.log-row { display: grid; grid-template-columns: 140px 1fr 120px 80px 80px 60px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(56,68,100,0.2); font-size: 12px; align-items: center; cursor: pointer; transition: all 0.25s; }
.log-row:hover { background: rgba(99,102,241,0.05); }
.log-header { font-weight: 700; color: var(--text-muted); font-family: ${font}; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; cursor: default; }
.log-header:hover { background: transparent; }
.log-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.log-models { font-family: ${font}; color: var(--text-muted); font-size: 11px; }
.log-cost { font-family: ${font}; color: var(--amber); }
.log-replay { padding: 3px 8px; font-size: 10px; border-radius: 4px; border: 1px solid var(--glass-border); background: transparent; color: var(--accent); cursor: pointer; font-family: ${font}; transition: all 0.25s; }
.log-replay:hover { background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3); }

/* Settings */
.setting-group { margin-bottom: 24px; }
.setting-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.setting-input { width: 100%; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 8px; padding: 10px 12px; color: var(--text-primary); font-family: ${font}; font-size: 13px; outline: none; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.setting-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.06); }
.setting-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.api-test-btn { padding: 8px 16px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; border-radius: 6px; font-family: ${font}; font-size: 12px; cursor: pointer; margin-top: 8px; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.api-test-btn:hover:not(:disabled) { box-shadow: 0 4px 16px rgba(99,102,241,0.35); transform: translateY(-1px); }
.api-test-btn:active:not(:disabled) { transform: scale(0.97); }
.api-test-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Empty State */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 300px; color: var(--text-muted); text-align: center; gap: 12px; }
.empty-state .emoji { font-size: 48px; }
.empty-state .msg { font-size: 14px; max-width: 300px; line-height: 1.5; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(5,8,22,0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 1000; display: flex; align-items: center; justify-content: center; cursor: pointer; animation: fadeIn 0.25s ease; }
.lightbox img, .lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
.lightbox-close { position: fixed; top: max(16px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right)); z-index: 1001; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,0.3); border-radius: 50%; background: rgba(8,12,25,0.88); color: white; font-size: 28px; line-height: 1; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.45); }
.lightbox-close:hover { background: var(--accent); border-color: var(--accent); }
.lightbox-close:focus-visible { outline: 3px solid white; outline-offset: 3px; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* Animations */
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes glowPulse { 0%,100% { box-shadow: 0 0 12px rgba(99,102,241,0.15); } 50% { box-shadow: 0 0 24px rgba(99,102,241,0.3); } }
.fade-in { animation: fadeIn 0.35s cubic-bezier(0.4,0,0.2,1); }
.pulse { animation: pulse 1.5s ease-in-out infinite; }
.content { animation: fadeIn 0.3s ease; }
.task-status.processing { animation: glowPulse 2s ease-in-out infinite; }

@media (max-width: 768px) {
  /* Lock horizontal scroll — no page panning at all */
  html, body, #root, .proxima-app, .main, .content { overflow-x: hidden; max-width: 100vw; }
  .proxima-app { flex-direction: column; }
  .sidebar { width: 100%; flex-direction: row; padding: 0 8px 0 max(8px, env(safe-area-inset-left)); gap: 2px; border-right: none; border-bottom: 1px solid var(--glass-border); overflow-x: auto; flex-shrink: 0; height: 56px; padding-top: env(safe-area-inset-top); justify-content: center; background: rgba(5,8,22,0.3); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .sidebar-logo { margin-bottom: 0; margin-right: 10px; font-size: 20px; }
  .sidebar-btn { width: 46px; height: 46px; font-size: 22px; }

  .topbar { height: 46px; padding: 0 16px; background: rgba(5,8,22,0.3); }
  .topbar-title { font-size: 11px; letter-spacing: 0.4px; }

  /* Page-scroll container: large bottom pad so the sticky gen bar never covers content */
  .content { padding: 14px 14px calc(160px + env(safe-area-inset-bottom)) 14px; -webkit-overflow-scrolling: touch; }

  .cockpit { grid-template-columns: 1fr; gap: 12px; height: auto; min-height: auto; position: relative; }
  .cockpit-left { padding-right: 0; padding-bottom: 0; gap: 12px; overflow: visible; min-height: auto; }
  .cockpit-left::-webkit-scrollbar { display: none; }
  .cockpit-right { overflow: visible; padding-bottom: 0; }

  /* All 5 tabs fit on one row: icon stacked above short label, equal flex distribution */
  .type-tabs-wrap { margin: 0; }
  .type-tabs-wrap::after { display: none; }
  .type-tabs { gap: 3px; padding: 3px; border-radius: 11px; overflow: hidden; flex-wrap: nowrap; width: 100%; }
  .type-tab { padding: 7px 2px; font-size: 9.5px; border-radius: 9px; flex: 1 1 0; min-width: 0; max-width: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; line-height: 1.2; letter-spacing: 0.2px; font-weight: 600; white-space: nowrap; }
  .type-tab .tab-icon { display: block; font-size: 16px; line-height: 1; }
  .type-tab .tab-label-full { display: none; }
  .type-tab .tab-label-short { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }

  .card { padding: 14px; border-radius: 14px; }
  .card-title { font-size: 11px; margin-bottom: 10px; letter-spacing: 0.8px; }

  .prompt-area { min-height: 96px; padding: 13px; font-size: 16px; border-radius: 11px; }

  /* On taller screens, expand the model list so users see more without scrolling the inner panel */
  .model-selector-header { align-items: flex-start; flex-wrap: wrap; }
  .model-selector-header > span { padding-top: 4px; }
  .model-actions { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
  .model-action-btn { min-height: 44px; padding: 8px 12px; border-radius: 9px; font-size: 11px; }
  .model-grid { max-height: 320px; gap: 6px; }

  .model-item { grid-template-columns: minmax(0, 1fr) 44px; padding: 8px 8px 8px 14px; border-radius: 11px; gap: 4px; min-height: 60px; }
  .model-choice { display: grid; grid-template-columns: 34px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 0; row-gap: 5px; width: 100%; min-height: 44px; padding: 0; align-items: center; }
  .model-check { grid-column: 1; grid-row: 1 / span 2; width: 22px; height: 22px; border-radius: 6px; font-size: 13px; margin: 0 12px 0 0; }
  .model-name { grid-column: 2; grid-row: 1; font-size: 14.5px; white-space: normal; overflow: visible; text-overflow: unset; min-width: 0; line-height: 1.3; }
  .model-meta { grid-column: 2; grid-row: 2; display: flex; align-items: center; gap: 8px; width: 100%; padding: 0; margin: 0; }
  .model-provider { font-size: 11px; padding: 3px 8px; border-radius: 5px; }
  .hot-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
  .model-price { font-size: 13px; margin-left: auto; }
  .model-favorite-btn { width: 44px; height: 44px; font-size: 23px; border-radius: 10px; }

  .settings-row { gap: 10px; }
  .settings-row label { font-size: 13px; }
  .settings-select, .settings-input { padding: 10px 12px; font-size: 14px; border-radius: 8px; min-width: 80px; min-height: 40px; }

  /* Sticky bottom action panel — contains cost + generate button, always reachable by thumb on 6.7" phones */
  .action-panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)) 14px; background: linear-gradient(to top, rgba(2,5,16,0.97) 60%, rgba(2,5,16,0.8) 90%, rgba(2,5,16,0)); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-top: 1px solid rgba(99,102,241,0.15); display: flex; flex-direction: column; gap: 8px; }
  .action-panel .cost-bar { margin: 0; padding: 9px 14px; font-size: 13px; border-radius: 10px; }
  .action-panel .gen-btn { margin: 0; }
  .action-panel .gen-hint { display: none; }
  .gen-btn { padding: 15px; font-size: 15px; border-radius: 12px; min-height: 52px; letter-spacing: 0.8px; }

  .cost-bar { padding: 12px 16px; font-size: 14px; border-radius: 10px; }

  .task-card { padding: 16px; border-radius: 14px; margin-bottom: 14px; }
  .task-model { font-size: 15px; }
  .task-status { font-size: 12px; padding: 4px 10px; }
  .task-timer { font-size: 13px; }

  .result-img { border-radius: 10px; max-height: 400px; }
  .result-video { border-radius: 10px; max-height: 400px; }
  .result-actions { gap: 8px; margin-top: 12px; }
  .result-action-btn { min-height: 44px; padding: 8px 6px; font-size: 12px; border-radius: 8px; }

  .results-grid { grid-template-columns: 1fr; gap: 14px; }

  .log-row { grid-template-columns: minmax(0, 1fr) 128px 50px; gap: 6px; padding: 12px 14px; font-size: 13px; }
  /* fixed column keeps rows aligned; at 10px JetBrains Mono (6.0px/glyph, measured with the font loaded) labels up to
     21 chars fit ("12 models · 48 images"), longer ones get an ellipsis */
  .log-models { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Hidden by class, not position: select mode inserts a checkmark first, which shifted nth-child hiding
     (the checkmark vanished and time + replay showed instead, wrapping the row). */
  .log-row > .log-hide-m { display: none; }

  .setting-group { margin-bottom: 28px; }
  .setting-label { font-size: 14px; margin-bottom: 8px; }
  .setting-input { padding: 14px 16px; font-size: 15px; border-radius: 10px; }
  .setting-hint { font-size: 13px; margin-top: 6px; }
  .api-test-btn { padding: 12px 20px; font-size: 14px; border-radius: 8px; }

  .empty-state { height: 200px; }
  .empty-state .emoji { font-size: 40px; }
  .empty-state .msg { font-size: 15px; }
}
`;

// ─── HELPERS ───
// Loading bar fills over a fixed 1 minute for every model, regardless of its output time
const PROGRESS_BAR_MS = 60000;

function genId() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}
function formatCost(c) { return `$${c.toFixed(4)}`; }
// "1 model · 4 images" when a batch fans out (or natively batches) one model into several images.
function logModelsLabel(log) {
  const models = new Set(log.models || []).size;
  const images = (log.tasks || []).reduce((n, t) => n + (t.outputs?.length || 0), 0);
  return `${models} model${models === 1 ? "" : "s"}${images > models ? ` · ${images} images` : ""}`;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return formatTimestamp(ts);
}
function formatTimestamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true, month: "short", day: "numeric" });
}

// ─── API SERVICE ───

// ─── CockpitTaskCard ───
// Memoized so each card only re-renders when its OWN task changes.
// Before this extraction, every poll tick / keystroke / model toggle re-rendered all 500+ cards.
// Live trace 2026-05-15 measured 13.9 FPS during typing because of this.
const CockpitTaskCard = memo(function CockpitTaskCard({
  task,
  currentGenType,
  onRegenerate,
  onCancel,
  onDownload,
  onCloudArchive,
  onCopyUrl,
  onEdit,
  onAnimate,
  onLightbox,
  selectMode = false,
  selected = false,
  onToggleSelect,
}) {
  const tType = task.genType || currentGenType;
  const actionCount = task.status === "completed" && (tType === "image" || tType === "i2i") ? 6
    : task.status === "completed" ? 4 : 1;
  // Only terminal generations are selectable — deleting an in-flight task would race
  // its still-running poll loop (which calls saveTask/syncTask) and resurrect it.
  const deletable = task.status === "completed" || task.status === "failed";
  const selecting = selectMode && deletable;
  const toggle = () => onToggleSelect && onToggleSelect(task.id);
  return (
    <div className={`task-card fade-in${selected ? " card-selected" : ""}${selecting ? " selecting-card" : ""}${selectMode && !deletable ? " card-unselectable" : ""}`}
      onClick={selecting ? toggle : undefined}
      role={selecting ? "checkbox" : undefined}
      aria-checked={selecting ? selected : undefined}
      aria-label={selecting ? `Select ${task.modelName} generation` : undefined}
      tabIndex={selecting ? 0 : undefined}
      onKeyDown={selecting ? (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } } : undefined}
      style={selecting ? { cursor: "pointer", position: "relative" } : (selectMode ? { position: "relative" } : undefined)}>
      {selecting && (
        <div aria-hidden="true" className={`select-check${selected ? " on" : ""}`}>{selected ? "✓" : ""}</div>
      )}
      <div className="task-header">
        <div>
          <span className="task-model">{task.modelName}{task.batchImageIndex && task.requestedImages > 1 && <span className="task-batch-index">{task.batchImageIndex}/{task.requestedImages}</span>}</span>
          <span style={{ fontSize: 10, color: PROVIDER_COLORS[task.provider] || "#aaa", marginLeft: 6 }}>{task.provider}</span>
          {(task.actualRes || task.actualDur) && (
            <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 6 }}>
              {[task.actualRes, task.actualDur ? task.actualDur + "s" : null].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <span className={`task-status ${task.status}`}>
          {task.status === "pending" ? "PENDING" : task.status === "processing" ? "PROCESSING" : task.status === "completed" ? "DONE" : "FAILED"}
        </span>
      </div>

      <div className="task-timer">
        {task.status === "completed" ? `✓ ${formatTime(task.wallClockMs)}` :
         task.status === "failed" ? `✗ ${task.error}` :
         <span className="pulse">⏱ {formatTime(task.wallClockMs)}</span>}
        {task.status === "completed" && <span style={{ marginLeft: 8, color: "var(--amber)" }}>{formatCost(task.price)}</span>}
        {task.startTime && (
          <span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 11 }}>
            · {formatTimestamp(task.startTime)} EST
          </span>
        )}
      </div>

      {(task.status === "pending" || task.status === "processing") && (
        <>
          <div className="task-progress">
            <div className="task-progress-fill" style={{
              width: `${Math.min(95, (task.wallClockMs / PROGRESS_BAR_MS) * 100)}%`
            }} />
          </div>
          <button className="result-action-btn" style={{ marginTop: 6, fontSize: 10 }} onClick={() => onCancel(task.id)}>✕ Cancel</button>
        </>
      )}

      {task.status === "completed" && task.outputs?.map((url, i) => {
        const is3D = tType === "i23d" || /\.(glb|obj|fbx|usdz|stl)(\?|$)/i.test(url);
        const isVideo = !is3D && (url.includes(".mp4") || url.includes("video") || tType === "t2v" || tType === "i2v" || tType === "avatar");
        if (is3D) {
          return (
            <a key={i} href={url} target="_blank" rel="noopener" download
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: 28, marginTop: 10, background: "var(--bg-input)", border: "1px solid var(--glass-border)", borderRadius: 10, color: "var(--text-primary)", textDecoration: "none", transition: "border-color 0.2s", pointerEvents: selecting ? "none" : undefined }}
              onMouseOver={e => e.currentTarget.style.borderColor = "var(--accent)"}
              onMouseOut={e => e.currentTarget.style.borderColor = "var(--glass-border)"}>
              <div style={{ fontSize: 56 }}>🧊</div>
              <div style={{ fontFamily: font, fontSize: 13, fontWeight: 600 }}>3D Mesh Ready</div>
              <div style={{ fontFamily: font, fontSize: 10, color: "var(--text-muted)" }}>Tap to open / download · {url.split(".").pop().split("?")[0].toUpperCase()}</div>
            </a>
          );
        }
        return isVideo ? (
          <video key={i} className="result-video" src={url} controls autoPlay muted loop playsInline style={{ pointerEvents: selecting ? "none" : undefined }} />
        ) : (
          <img key={i} className="result-img" src={url} alt={task.modelName}
            onClick={selecting ? undefined : () => onLightbox(url)} loading="lazy" decoding="async"
            style={{ pointerEvents: selecting ? "none" : undefined }} />
        );
      })}

      {!selectMode && (task.status === "completed" || task.status === "failed") && (
        <div className={`result-actions result-actions-${actionCount}`}>
          <button className="result-action-btn" style={{ color: "var(--accent)", borderColor: "rgba(99,102,241,0.3)" }}
            onClick={() => onRegenerate(task)}>🔄 Regenerate</button>
          {task.status === "completed" && <>
            <button className="result-action-btn" title="Download to device" onClick={() => onDownload(task)}>↓ Download</button>
            <button className="result-action-btn" title="Back up to cloud storage (permanent)"
              disabled={task.isArchived}
              style={task.isArchived ? { color: "var(--success)", borderColor: "rgba(34,197,94,0.3)" } : { color: "var(--amber)", borderColor: "rgba(245,158,11,0.3)" }}
              onClick={() => onCloudArchive(task)}>
              {task.archiving ? "☁ …" : task.isArchived ? "☁ Saved" : "☁ Cloud"}
            </button>
            <button className="result-action-btn" onClick={() => onCopyUrl(task)}>📋 URL</button>
            {(tType === "image" || tType === "i2i") && (
              <button className="result-action-btn" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,0.3)" }}
                onClick={() => onEdit(task)}>
                ✏️ Edit
              </button>
            )}
            {(tType === "image" || tType === "i2i") && (
              <button className="result-action-btn" style={{ color: "var(--warning)", borderColor: "rgba(245,158,11,0.3)" }}
                onClick={() => onAnimate(task)}>
                🎬 Animate
              </button>
            )}
          </>}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom equality: re-render only when this task's identity OR currentGenType changes,
  // OR this card's selection state / select-mode changes (so checkboxes update live).
  // Handler refs are assumed stable (parent useCallback). If parent re-renders for an
  // unrelated reason (typing in the prompt, switching pages), unchanged tasks skip render.
  return prev.task === next.task
    && prev.currentGenType === next.currentGenType
    && prev.selectMode === next.selectMode
    && prev.selected === next.selected;
});

// ─── MAIN APP ───
function localModelFavoritesKey(scope = getDeviceId()) {
  return `${MODEL_FAVORITES_SETTING}:${encodeURIComponent(scope)}`;
}

export default function ProximaApp() {
  // Signed in = an unexpired server-issued session token (see lib/session.js).
  // Second account S5 (src/lib/accountGuard.js; review r6 #1): a session restored at load is used at once only when this
  // browser's record names its account. With no record yet, the server is asked whose session it is and the guard decides
  // BEFORE anything loads or syncs (isAuthed stays false meanwhile); a failed check never falls back to trusting it.
  const [bootFit] = useState(() => {
    const decision = bootSessionDecision(getSession(), readBrowserAccount());
    if (decision === "refuse") clearSession();
    if (decision === "fit") bindPageAccount(tokenAccountId(getSession()?.token));
    return decision;
  });
  const [isAuthed, setIsAuthed] = useState(bootFit === "fit");
  const isAuthedRef = useRef(isAuthed);
  isAuthedRef.current = isAuthed;
  // Review r8 (#1/#6): a page that must leave (another account's session, or signed out elsewhere) stops sending at once,
  // skips its unload flush and the "Reload site?" prompt (its writes are in the failed-sync queue and replay under the
  // right session), and reloads so the load decision runs again.
  const leavingRef = useRef(false);
  function leavePage() {
    if (leavingRef.current) return;
    leavingRef.current = true;
    isAuthedRef.current = false;
    window.location.reload();
  }
  useEffect(() => {
    onForeignSession(leavePage);
    return () => onForeignSession(null);
  }, []);
  const [accountCheck, setAccountCheck] = useState(bootFit === "check" ? "checking" : null);   // "checking" | "failed" | null
  const [sessionRefusal, setSessionRefusal] = useState(() => (bootFit === "refuse"
    ? browserAccountMessage(readBrowserAccount()?.unreadable ? { reason: "unreadable-record" } : { reason: "other-account", other: readBrowserAccount()?.username })
    : ""));
  const [sessionNotice, setSessionNotice] = useState("");
  const [joinLink, setJoinLink] = useState(() => { const j = takeJoinHash(); return bootFit === "none" || bootFit === "refuse" ? j : null; });
  useEffect(() => {
    // An invite link opened in this tab later; signed in, it is only removed from the address.
    const onHash = () => { const j = takeJoinHash(); if (j && !isAuthedRef.current) setJoinLink(j); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Review r7 (security #1/#2), r8 (#4/#14): another tab signing in or out, or claiming this browser for another account
  // (a null key: its storage was cleared): a signed-in page that is no longer on its own account's session, or whose
  // session no longer fits the record, leaves instead of sending its work under the other session.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key != null && e.key !== "proximaai-session" && e.key !== BROWSER_ACCOUNT_KEY) return;
      if (pageMustLeave({ authed: isAuthedRef.current, pageAccount: pageAccountId(), token: getSession()?.token, stored: readBrowserAccount() })) leavePage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  function refuseSession(message) { clearSession(); setAccountCheck(null); setSessionRefusal(message); }
  useEffect(() => {
    if (accountCheck !== "checking") return;
    let cancelled = false;
    const checked = getSession()?.token;
    (async () => {
      // Review r7 #6: a time limit (a stalled connection would otherwise hold this screen for minutes). Review r8 #3: the
      // answer is acted on only for the session it was asked about (accountGuard.js accountCheckStep): another tab's
      // sign-in or sign-out meanwhile starts the page again; only the server's 'forbidden' drops the session.
      let answer;
      try { answer = await Promise.race([getMyAccount(), new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), 15000))]); } catch {}
      if (cancelled) return;
      const step = accountCheckStep({ checked, now: getSession()?.token, answer });
      if (step === "restart") { window.location.reload(); return; }
      if (step === "expired") { setAccountCheck(null); setSessionNotice(SESSION_EXPIRED); return; }
      if (step === "drop") { clearSession(); setAccountCheck(null); setSessionNotice(SESSION_EXPIRED); return; }
      if (step !== "decide") { setAccountCheck("failed"); return; }
      try {
        const a = answer;
        const verdict = browserAccountDecision({ stored: readBrowserAccount(), hasLocalData: await hasLocalData(), account: { id: a.id, role: a.role, username: a.username } });
        if (cancelled) return;
        if (getSession()?.token !== checked) { window.location.reload(); return; }   // changed while the data was counted
        if (!verdict.ok) { refuseSession(browserAccountMessage(verdict)); return; }
        if (verdict.claim && !claimBrowser({ id: a.id, role: a.role, username: a.username })) { refuseSession(browserAccountMessage({ reason: "claim-failed" })); return; }
        setAccountCheck(null);
        bindPageAccount(tokenAccountId(getSession()?.token));
        setIsAuthed(true);
      } catch { if (!cancelled) setAccountCheck("failed"); }
    })();
    return () => { cancelled = true; };
  }, [accountCheck]);
  useEffect(() => {
    if (accountCheck !== "failed") return;
    const back = () => setAccountCheck("checking");
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [accountCheck]);
  const [page, setPage] = useState("cockpit");
  // The WaveSpeed key lives on the server. keyStatus comes from a balance check through the proxy:
  // "ok" | "missing" (none saved) | "invalid" (WaveSpeed rejected it) | "unknown" (not checked / network).
  const [keyStatus, setKeyStatus] = useState("unknown");
  const [keyInput, setKeyInput] = useState("");
  // Provider keys (docs/SECOND-ACCOUNT-PLAN.md K1): the providers this account saved a key for (null = not known yet),
  // with masked fingerprints for Settings. An account with a kie.ai key is never blocked by a missing WaveSpeed key:
  // its models, polls and resumes run through kie.ai.
  // The account is the session token's subject (u:<uuid>): stable across renames. Until the server answers, the model list
  // uses what this account last had (storage.js cachedProviderKeys); a failed read keeps what is known (S3 review #9).
  const accountOf = () => (getSession()?.token || "").split(".")[0] || null;
  const [providerKeys, setProviderKeys] = useState(() => {
    const a = accountOf(), c = a ? cachedProviderKeys(a) : null;
    return c ? new Set(c) : null;
  });
  const [providerKeyList, setProviderKeyList] = useState([]);
  const providerKeysRef = useRef(providerKeys);
  providerKeysRef.current = providerKeys;
  const refreshProviderKeys = useCallback(async () => {
    const acct = accountOf();
    const list = await myProviderKeys();
    if (list) {
      const providers = new Set(list.map(k => k.provider));
      if (acct) cacheProviderKeys(acct, providers);
      setProviderKeyList(list);
      setProviderKeys(providers);
      return;
    }
    setProviderKeys(prev => {
      if (prev) return prev;
      const c = acct ? cachedProviderKeys(acct) : null;
      return c ? new Set(c) : null;
    });
  }, []);
  const [kieKeyInput, setKieKeyInput] = useState("");
  const [kieTestStatus, setKieTestStatus] = useState(null); // null | "testing" | {ok, msg}
  // "invalid" once kie.ai rejects the saved key on a poll or submit (its polls then stop); "ok" after a working Save & Test.
  const [kieKeyStatus, setKieKeyStatus] = useState("unknown");
  const hasKieKey = !!providerKeys?.has("kie");
  const keyBlocked = (keyStatus === "missing" || keyStatus === "invalid") && !hasKieKey;
  const kieFingerprint = providerKeyList.find(k => k.provider === "kie")?.fingerprint || null;
  const refreshBalance = useCallback(async () => {
    const r = await checkBalance();
    if (r.balance !== null) setBalance(r.balance);
    // A missing or rejected key has no balance: never leave the old key's amount next to the warning.
    else if (r.keyStatus === "missing" || r.keyStatus === "invalid") setBalance(null);
    if (r.keyStatus !== "unknown") setKeyStatus(r.keyStatus);
    return r;
  }, []);
  const [balance, setBalance] = useState(null);
  const [genType, setGenType] = useState("image");
  const [selectedModels, setSelectedModels] = useState([]);
  const [favoriteModelsByType, setFavoriteModelsByType] = useState(() => emptyModelFavorites());
  const favoriteModelsRef = useRef(emptyModelFavorites());
  const favoriteModelsUpdatedAtRef = useRef(0);
  const favoriteSyncChainRef = useRef(Promise.resolve());
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [resolution, setResolution] = useState("1k");
  const [duration, setDuration] = useState(5);
  const [seed, setSeed] = useState("-1");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [perModelRes, setPerModelRes] = useState({});
  const [optionalParams, setOptionalParams] = useState({}); // C1: optional-param key -> value (Advanced panel)
  const [briaPresets, setBriaPresets] = useState({});       // C1: model.id -> Bria preset value
  const [sourceImageUrl, setSourceImageUrl] = useState("");
  const [sourceImageUrls, setSourceImageUrls] = useState([]); // multi-image support
  const [sourcePreview, setSourcePreview] = useState("");
  // C2: extra i2v inputs (end frame image, reference video) — shown per model capability flag
  const [endFrameUrl, setEndFrameUrl] = useState("");
  const [endFramePreview, setEndFramePreview] = useState("");
  const [endFrameStatus, setEndFrameStatus] = useState("");
  const [refVideoUrl, setRefVideoUrl] = useState("");
  // C3: avatar audio + driving-video inputs
  const [sourceAudioUrl, setSourceAudioUrl] = useState("");
  const [sourceAudioStatus, setSourceAudioStatus] = useState("");
  const [sourceVideoUrl, setSourceVideoUrl] = useState("");
  const [sourceVideoStatus, setSourceVideoStatus] = useState("");
  // Input media URL -> seconds (null = unreadable). Models priced by input length (get_duration) need it.
  const [mediaDurations, setMediaDurations] = useState({});
  const mediaDurationsRef = useRef(mediaDurations);
  mediaDurationsRef.current = mediaDurations;
  const probedMediaRef = useRef(new Set());
  useEffect(() => {
    const urls = [genType === "v2v" ? sourceImageUrl : "", sourceVideoUrl, sourceAudioUrl, refVideoUrl]
      .map(url => url?.trim() || "").filter(url => /^https?:\/\/\S+$/.test(url) && !probedMediaRef.current.has(url));
    if (urls.length === 0) return;
    const timer = setTimeout(() => { // pasted URLs change per keystroke: measure once typing settles
      for (const url of urls) {
        probedMediaRef.current.add(url);
        probeMediaDuration(url).then(seconds => setMediaDurations(prev => ({ ...prev, [url]: seconds })));
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [genType, sourceImageUrl, sourceVideoUrl, sourceAudioUrl, refVideoUrl]);
  const [uploadStatus, setUploadStatus] = useState(""); // "" | "uploading" | "done" | "error"
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | {ok, msg}
  const fileInputRef = useRef(null);
  const endFrameInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const multiImageInputRef = useRef(null);
  const [tasks, setTasks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    if (!lightbox) return;
    const closeOnEscape = (event) => { if (event.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightbox]);
  const [defaultImageRes, setDefaultImageRes] = useState("1k");
  const [defaultVideoDur, setDefaultVideoDur] = useState(5);
  const [galleryTabState, setGalleryTabState] = useState("completed");
  const [galleryView, setGalleryView] = useState("masonry");
  // ── Bulk-select / delete generations ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // ── Bulk-select / delete generation LOGS (separate from generations above) ──
  const [logSelectMode, setLogSelectMode] = useState(false);
  const [logSelectedIds, setLogSelectedIds] = useState(() => new Set());
  const [bulkDeletingLogs, setBulkDeletingLogs] = useState(false);
  const [numImages, setNumImages] = useState(1);
  const [storageStats, setStorageStats] = useState(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountToast, setAccountToast] = useState("");
  // ── Theme + animated background settings ──
  const [theme, setThemeState] = useState(() => { try { return localStorage.getItem("proximaai-theme") || "default"; } catch { return "default"; } });
  const [background, setBackgroundState] = useState(() => {
    try {
      const v = localStorage.getItem("proximaai-background");
      // Migrate legacy "void" preference to "orbs" since we removed the image bg
      return (!v || v === "void") ? "orbs" : v;
    } catch { return "orbs"; }
  });
  const [lightMode, setLightModeState] = useState(() => { try { return localStorage.getItem("proximaai-lightMode") === "1"; } catch { return false; } });
  const [archiveStats, setArchiveStats] = useState({ bytes: 0, count: 0 });
  useTheme({ theme, lightMode });

  // An archive that finished while a clear held its task (review round 15 S5; storage.js recordStashArchive), re-applied
  // when that clear is voided: the restored task gets the archived outputs and paths (it does not come back stuck as
  // archiving, and its files are owned again, so the file-delete queue keeps them), and its upload is queued, as the
  // archive would have done with no clear in the way. A record whose uploads all failed only ends the archiving state.
  // `base`: task versions just given back (not in tasksRef yet).
  const reapplyArchives = (archives, base = new Map()) => {
    for (const [id, rec] of Object.entries(archives || {})) {
      const cur = tasksRef.current.find(t => t.id === id) || base.get(id);
      if (!rec?.task) {
        if (cur?.archiving) { setTasks(prev => prev.map(t => (t.id === id ? { ...t, archiving: false } : t))); saveTask({ ...cur, archiving: false }); }
        continue;
      }
      const patch = { outputs: rec.task.outputs, archivedOutputs: rec.task.archivedOutputs, archivedPaths: rec.task.archivedPaths, isArchived: true, archiving: false };
      const updated = { ...(cur || rec.task), ...patch };
      setTasks(prev => (prev.some(t => t.id === id) ? prev.map(t => (t.id === id ? { ...t, ...patch } : t)) : [...prev, updated]));
      saveTask(updated);
      addFailedSync({ kind: "task", id, data: updated });   // queued first (CLAUDE.md), replayed by the next save pass
    }
  };
  // Reset's local favorites state, put back by a later void (review round 15 S3) as the inline voided branch does, only
  // while the favorites are still the ones the reset wrote (a newer choice wins). Returns the local setting restored, or
  // null.
  const restoreStashedFavorites = (fav) => {
    if (!fav || !(fav.resetAt > 0) || favoriteModelsUpdatedAtRef.current !== fav.resetAt) return null;
    const byType = fav.byType || emptyModelFavorites();
    const setting = fav.setting ?? createModelFavoritesSetting(byType, fav.updatedAt || 0);
    favoriteModelsRef.current = byType;
    favoriteModelsUpdatedAtRef.current = fav.updatedAt || 0;
    setFavoriteModelsByType(byType);
    setSetting(localModelFavoritesKey(fav.scope || getDeviceId()), setting);
    putBackQueuedUploads(fav.queued || []);
    return setting;
  };

  // A clear voided LATER (its call got no answer; a restore that landed after it voids its intents at a replay, through
  // restoreGuard or the server's restore check) loses nothing of this device either (review round 14): the stash it
  // stored before its take (storage.js writeClearStash) gives back the queued uploads it took and the local-only tasks
  // and History entries it removed. A version this device holds now is newer and stays; an id queued for deletion again
  // (by another clear or delete) stays deleted. `which(at)`: the stashes to give back, by their clear's queue time.
  // A stash is given back only once NONE of its clear's intents is pending in either kind (review round 15 S1,
  // storage.js stashGiveBack): a task group voided first must not give it back (and drop it) while the same clear's
  // History group still holds its entries back. Ids confirmed meanwhile already left the stash (S2), archives it held
  // are re-applied (S5) and a Reset's favorites come back (S3). Returns { favorites: the local setting restored | null }.
  // `held` (round 17): what an inline voided branch has just put back in memory (the refs do not see it yet), so those
  // versions win: `tasks` (id -> task, also the base its archives re-apply onto) and `logs` (ids).
  const applyClearStashes = (which, held = {}) => {
    let any = false, favorites = null;
    const heldTasks = held.tasks || new Map(), heldLogs = held.logs || new Set();
    for (const s of readClearStashes()) {
      if (!which(s.at)) continue;
      const back = stashGiveBack(s);
      if (!back) continue;   // an intent of this clear is still pending: its own void or confirm decides
      any = true;
      putBackQueuedUploads(back.uploads);
      const { tasks, logs } = back;
      const haveTasks = new Set([...tasksRef.current.map(t => t.id), ...heldTasks.keys()]), haveLogs = new Set([...logsRef.current.map(l => l.id), ...heldLogs]);
      const backTasks = tasks.filter(t => !haveTasks.has(t.id)), backLogs = logs.filter(l => !haveLogs.has(l.id));
      // Task B16 (review round 29 #2): the kept generations and entries this tab's state still shows go to IndexedDB too
      // (this tab's copy, the newer one): once the stash is dropped below, another tab's pass finds them nowhere else.
      const shownTasks = tasks.filter(t => haveTasks.has(t.id) && !heldTasks.has(t.id)).map(t => tasksRef.current.find(x => x.id === t.id) || t);
      const shownLogs = logs.filter(l => haveLogs.has(l.id) && !heldLogs.has(l.id)).map(l => logsRef.current.find(x => x.id === l.id) || l);
      // Task B15 (review round 28 #1/#3/#5): IndexedDB is written in transactions CREATED here, before the stash is dropped
      // below, so another tab's pass finds these generations in the stash or in IndexedDB whatever the order (it reads the
      // stash before its IndexedDB read too). B14's deferred drop is gone: it re-decided the stash later (#1) and skipped a
      // follower's give-back (#3).
      if (backTasks.length) {
        setTasks(prev => { const have = new Set(prev.map(t => t.id)); const add = backTasks.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
      }
      saveTasksNow([...backTasks, ...shownTasks]);
      if (backLogs.length) {
        setLogs(prev => { const have = new Set(prev.map(l => l.id)); const add = backLogs.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
      }
      addHistoryEntriesNow([...backLogs, ...shownLogs]);
      reapplyArchives(back.archives, new Map([...heldTasks, ...backTasks.map(t => [t.id, t])]));
      // Task B8b (review round 21 #3): an archive record of a task confirmed deleted after this clear is never re-applied
      // (giveBackRule); its files go through the file-delete queue, as a confirm's forgetStashedIds sends them.
      queueArchivedFileDeletes(back.goneArchivePaths);
      favorites = restoreStashedFavorites(back.favorites) || favorites;
      // Owner ruling 2026-10-23: the put-back no longer cancels the holds of what it gives back (task B12b's keepGivenBack):
      // the restore that voided this clear may have removed those generations too, so the next pass that read the cloud
      // after it decides their files and WaveSpeed results (kept if they came back or this browser keeps them).
      applyRelinks([...heldTasks.values(), ...backTasks]);   // task B13a (round 26 #6): relinks already ready, applied to them now
      dropGivenBackStash(s);   // task B5: the part still pending at a time its ids moved to stays for that one
    }
    if (any) setFailedSyncCount(getFailedSyncs().length);
    return { favorites };
  };
  // A stash is decided only once nothing is pending at its clear's queue time AND at every time its ids moved to (review
  // round 16 #5: a Reset pressed again, or a plain delete, re-queues them at its own time; storage.js stashDecision,
  // task B5). Until then it is left alone: no move, no drop. Then, if one of those times is a recorded VOIDED time
  // (storage.js voidDeleteIntents records every void, round 18 #3), it is given back: what is left in it is only content
  // whose deletes were not confirmed (confirmed ids left every stash, forgetStashedIds). Otherwise it was confirmed: it
  // goes, and archive records still in it belong to tasks that are gone (their files go through the file-delete queue,
  // S5). Task B5 removed the merge into the newest pending target (moveClearStash): a stash whose ids moved to two times
  // followed only the newest one, and lost the other's ids when that one was confirmed.
  const settleClearStashes = () => {
    const voided = voidedTimes();
    const back = new Set(readClearStashes().filter(s => stashDecision(s, voided) === "give-back").map(s => s.at));
    if (back.size) applyClearStashes(at => back.has(at));
    for (const s of readClearStashes()) if (stashDecision(s, voided) === "drop") {
      queueArchivedFileDeletes(stashArchivePaths(s)); dropClearStash(s.at);
    }
    pruneVoidedAt();
  };
  // Round 18 #3: the give-back of an inline void of a PLAIN delete (no stash of its own): the stashes whose ids moved to
  // it, read right after its voidDeleteIntents (several queue times: a bulk delete's task and History groups).
  const giveBackVoided = (...times) => {
    const which = times.map(Number).filter(t => Number.isFinite(t) && t > 0).map(t => voidedClearStashes(t));
    if (which.length) applyClearStashes(at => which.some(w => w(at)));
  };

  // Force-flush all pending cloud writes + replay any failed entries
  // Queued delete intents replay through the server's restore check (delete_queued_rows, review round 4), one call per
  // queue time: the check and the delete are one transaction, however long this device waited before sending. Voided
  // ids (a restore came after them) leave the queue and stop being "deleted" here, so the rows the restore brought back
  // return on the next pass; deleted ones leave this device too. A failed call leaves its intents queued.
  const replayDeleteIntents = async (kind) => {
    const isTask = kind === "task-delete";
    for (const [ts, ids] of intentGroups(kind)) {
      // Task B9 (review round 22 #2): in flight for every tab until its answer is handled (its confirm or void lands the
      // ids it answers; the finally the rest).
      const flight = beginDeleteFlight({ [kind]: ids }, ts);
      try {
      const r = await deleteQueuedRemote(isTask ? "task" : "history", ids, ts);
      if (r.voided.length) {
        voidDeleteIntents(kind, r.voided, ts);   // settled and recorded (round 18 #3)
        releaseVoided(isTask ? deletingIds : deletingLogIds, kind, r.voided);   // round 19 #1: a re-queued id is still going
      }
      if (r.deleted.length) {
        const gone = new Set(r.deleted);
        if (isTask) {
          setTasks(prev => prev.filter(t => !gone.has(t.id)));
          await deleteTasks(r.deleted);
          for (const id of r.deleted) savedTaskIds.current.delete(id);
        } else {
          setLogs(prev => prev.filter(l => !gone.has(l.id)));
          await deleteHistoryEntries(r.deleted);
          for (const id of r.deleted) savedLogIds.current.delete(id);
        }
        confirmIntents(kind, r.deleted, ts);
      }
      // A clear voided at its replay gives back what it removed here (round 14), once its other group is settled too
      // (round 15 S1: stashGiveBack waits while any intent at this queue time is pending, in either kind), and so does
      // every stash whose ids moved to it (round 17 #6: read now, before settleClearStashes could drop them as confirmed).
      if (r.voided.length) applyClearStashes(voidedClearStashes(ts));
      } finally { endDeleteFlight(flight); }
    }
  };

  // Queued History uploads (forceSaveAll, the mount replay). A delete's rewrite (queued with its queuedAt) goes through
  // upsert_queued_history, restore-checked like the delete (review round 9). None carries an item of a generation this
  // device deleted for good (storage.js historyUploadPlan); an entry left with no item is dropped instead of sent.
  const replayHistoryUploads = async (queued) => {
    // Round 19 #2: an entry whose delete was confirmed is never sent (withoutConfirmedUploads removes a stale one). Task
    // B7a: nor one of an entry another tab is deleting or deleted (uploadable, the shared delete state).
    const byId = new Map(uploadable("history", withoutConfirmedUploads(queued)).filter(f => f.data).map(f => [f.id, f]));
    // Task B9 (review round 22 #5/#7): the items of FINAL confirmed task deletes are stripped (an entry left with none is
    // dropped from the queue); an entry holding an item of a superseded confirm or of a call in flight stays queued for a
    // later replay (storage.js historyUploadPlan). A pending delete's items stay: its own transaction strips them.
    const { upload, skip } = historyUploadPlan([...byId.values()].map(f => f.data));
    for (const id of skip) removeFailedSync("history", id, sentVersion(byId.get(id).data));
    for (const entry of upload) {
      const f = byId.get(entry.id);
      try {
        if (f.queuedAt) { const r = await sendQueuedHistory([entry], f.queuedAt); if (r.ok && (r.upserted.length || r.voided.length)) removeFailedSync("history", entry.id, sentVersion(f.data)); }
        else if ((await sendHistoryEntry(entry)).length) removeFailedSync("history", entry.id, sentVersion(f.data));
      } catch {}
    }
  };

  const forceSaveAll = async () => {
    setSaveStatus("saving");
    // Delete intents replay only after the restore check (review round 3): a restore since they were queued voids
    // them, and while the settings cannot be read none is sent.
    const guard = restoreGuard(await pullSettings());
    for (const id of guard.voided.task) deletingIds.current.delete(id);
    for (const id of guard.voided.history) deletingLogIds.current.delete(id);
    if (guard.restoreAt > 0) applyClearStashes(at => at < guard.restoreAt);   // clears that restore voided (round 14)
    // Serialize with any click-triggered favorites save so an older snapshot can
    // never finish after a newer one and overwrite it.
    try { await favoriteSyncChainRef.current; } catch {}
    // Replay any cloud deletes that didn't confirm (bulk-delete dropped mid-flight) FIRST: a delete's History rewrite
    // replayed before it would leave the server no item to record a History-only generation's user tombstone from
    // (review round 7).
    if (guard.known) { await replayDeleteIntents("task-delete"); await replayDeleteIntents("history-delete"); settleClearStashes(); }
    pruneDeleting();   // task B7a (round 20 #8): "being deleted" follows the shared queue and this tab's own calls
    if (taskSyncTimerRef.current) { clearTimeout(taskSyncTimerRef.current); taskSyncTimerRef.current = null; }
    const queue = taskSyncQueueRef.current.splice(0).filter(t => !deletingIds.current.has(t.id));
    if (queue.length > 0) {
      try { for (const t of await sendTasks(queue)) removeFailedSync("task", t.id, sentVersion(t)); } catch {}
    }
    const failed = getFailedSyncs();
    // Deletes win over upserts: never re-upsert a task that's queued for deletion.
    // Round 19 #2: never an upload of a confirmed delete (withoutConfirmedUploads drops a stale one from the queue).
    const taskRetries = withoutConfirmedUploads(failed.filter(f => f.kind === "task" && !deletingIds.current.has(f.id))).map(f => f.data).filter(Boolean);
    if (taskRetries.length > 0) { try { for (const t of await sendTasks(taskRetries)) removeFailedSync("task", t.id, sentVersion(t)); } catch {} }
    await replayHistoryUploads(failed.filter(f => f.kind === "history" && !deletingLogIds.current.has(f.id)));
    for (const f of failed.filter(f => f.kind === "setting" && f.id !== "apiKey")) { try { await syncSetting(f.id, f.data); removeFailedSync("setting", f.id); } catch {} }
    const favoriteScope = getDeviceId();
    if (failed.some(f => f.kind === "model-favorites" && f.scope === favoriteScope)) {
      try { await flushQueuedModelFavorites(favoriteScope); } catch {}
    }
    const remaining = getFailedSyncs().length;
    setFailedSyncCount(remaining);
    if (remaining === 0) { setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000); }
    else setSaveStatus("error");
  };

  // Long-press handler: full manual cloud backup (settings + tasks + history + favorites)
  const triggerManualBackup = async () => {
    setSaveStatus("saving");
    // Flush everything first so the backup includes the very latest state
    await forceSaveAll();
    setSaveStatus("saving");
    const r = await createBackup("manual", "Long-press save from nav");
    if (r.ok) {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2500);
      setAccountToast("☁ Full backup saved to cloud");
      setTimeout(() => setAccountToast(""), 4000);
    } else {
      setSaveStatus("error");
      setAccountToast("Backup failed: " + (r.error || "unknown"));
      setTimeout(() => setAccountToast(""), 5000);
    }
  };

  const setTheme = (v) => {
    setThemeState(v);
    try { localStorage.setItem("proximaai-theme", v); } catch {}
    setSetting("theme", v);
    syncSetting("theme", v).catch(() => {});
  };
  const setBackground = (v) => {
    setBackgroundState(v);
    try { localStorage.setItem("proximaai-background", v); } catch {}
    setSetting("background", v);
    syncSetting("background", v).catch(() => {});
  };
  const setLightMode = (v) => {
    setLightModeState(v);
    try { localStorage.setItem("proximaai-lightMode", v ? "1" : "0"); } catch {}
    setSetting("lightMode", v ? "1" : "0");
    syncSetting("lightMode", v ? "1" : "0").catch(() => {});
  };

  const [saveStatus, setSaveStatus] = useState("idle"); // "idle" | "saving" | "saved" | "error"
  const pendingWritesRef = useRef(new Set());
  const saveStatusTimerRef = useRef(null);
  const [backups, setBackups] = useState([]);
  const [showBackupsPanel, setShowBackupsPanel] = useState(false);
  const [backupsReloading, setBackupsReloading] = useState(false);
  // "Automatic backups" switch (server-side, off by default; supabase.js getAutoBackups). null = unknown (not read yet,
  // or the read failed). Read again right before every destructive confirm, and whenever the tab comes back or goes
  // online, so a change made on the other device shows here (review wf_1945b758-923 #13/#14). Returns the value read.
  const [autoBackups, setAutoBackupsState] = useState(null);
  const [autoBackupsChecking, setAutoBackupsChecking] = useState(false);
  const readAutoBackups = useCallback(async () => {
    setAutoBackupsChecking(true);
    const v = await getAutoBackups();
    setAutoBackupsState(v); setAutoBackupsChecking(false);
    return v;
  }, []);
  useEffect(() => {
    if (!isAuthed) { setAutoBackupsState(null); return; }
    readAutoBackups();
    const onBack = () => { if (document.visibilityState === "visible") readAutoBackups(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("online", onBack);
    return () => { document.removeEventListener("visibilitychange", onBack); window.removeEventListener("online", onBack); };
  }, [isAuthed, readAutoBackups]);

  // Track any in-flight cloud write (lets the floating save button show live status)
  const markWriteStart = useCallback((key) => {
    pendingWritesRef.current.add(key);
    setSaveStatus("saving");
  }, []);
  const markWriteEnd = useCallback((key, ok) => {
    pendingWritesRef.current.delete(key);
    if (!ok) { setSaveStatus("error"); return; }
    if (pendingWritesRef.current.size === 0) {
      setSaveStatus("saved");
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
    }
  }, []);
  const trackedSync = useCallback(async (key, fn) => {
    markWriteStart(key);
    try { const r = await fn(); markWriteEnd(key, true); return r; }
    catch (e) { markWriteEnd(key, false); throw e; }
  }, [markWriteStart, markWriteEnd]);

  async function flushQueuedModelFavorites(scope) {
    favoriteSyncChainRef.current = favoriteSyncChainRef.current
      .catch(() => {})
      .then(async () => {
        // Read inside the serialized callback. A click may have replaced an older
        // retry while this callback was waiting, and only the newest snapshot wins.
        const pending = getFailedSyncs().find(f => f.kind === "model-favorites" && f.scope === scope);
        if (!pending?.data) return;
        await syncSetting(MODEL_FAVORITES_SETTING, pending.data, scope);
        const latest = getFailedSyncs().find(f => f.kind === "model-favorites" && f.scope === scope);
        if (latest?.data?.updatedAt === pending.data.updatedAt) removeFailedSync("model-favorites", scope);
      });
    try {
      await favoriteSyncChainRef.current;
    } finally {
      setFailedSyncCount(getFailedSyncs().length);
    }
  }
  const multiImageFileRef = useRef(null);
  const [activeCount, setActiveCount] = useState(0);
  const pollRefs = useRef({});
  const savedLogIds = useRef(new Set());
  const savedTaskIds = useRef(new Set());
  // Tasks being recovered after an older build wrongly failed them: their next outcome must be saved and synced even
  // though their failed copy already was (savedTaskIds would otherwise skip it).
  const recoveringIds = useRef(new Set());
  const isGeneratingRef = useRef(false);
  const timerRefs = useRef({});
  const initialLoadDone = useRef(false);
  const taskSyncQueueRef = useRef([]);
  const taskSyncTimerRef = useRef(null);
  const bootstrapInProgress = useRef(false);
  // Ids being bulk-deleted this session. Every place that would UPSERT a task to the
  // cloud (the debounced persistence effect, the unload flush, forceSaveAll, the mount
  // replay) skips ids in this set, so an in-flight/queued save can never resurrect a
  // generation the user just deleted. Every upload also goes through the shared filter
  // (sendTasks / sendHistory, storage.js uploadable), which other tabs' deletes reach.
  const deletingIds = useRef(new Set());
  // Same guard for generation logs: any path that would re-upsert a history row skips
  // ids in here, so a just-deleted log can't be resurrected by an in-flight sync.
  const deletingLogIds = useRef(new Set());
  // Task B7a (review round 20 #8): both sets are derived on every reconcile / forceSaveAll pass (pruneDeleting). An id
  // stays while a delete intent of its kind is pending in the SHARED queue (any tab) or this tab holds it: a delete call
  // of this tab still running (an object hold, from before its intent is queued until the handler ends), or a queue time
  // whose intents are still pending (History entries a task delete's server work removes). A confirmed delete stays
  // excluded through the shared confirmed record (storage.js sharedDeleteState), not through these sets, so an id whose
  // last pending time another tab voided is released here too.
  const deleteHoldsRef = useRef({ "task-delete": new Map(), "history-delete": new Map() });
  const holdDeleting = (kind, ids, hold) => {
    const m = deleteHoldsRef.current[kind];
    for (const id of ids || []) { if (!id) continue; if (!m.has(id)) m.set(id, new Set()); m.get(id).add(hold); }
  };
  const unholdDeleting = (kind, ids, hold) => {
    const m = deleteHoldsRef.current[kind];
    for (const id of ids || []) { const h = m.get(id); if (!h) continue; h.delete(hold); if (!h.size) m.delete(id); }
  };
  function pruneDeleting() {
    for (const [kind, ref] of [["task-delete", deletingIds], ["history-delete", deletingLogIds]]) {
      const holds = deleteHoldsRef.current[kind];
      for (const id of settledDeletingIds(ref.current, kind, holds)) { ref.current.delete(id); holds.delete(id); }
    }
  }
  const draftFormRef = useRef(null);   // the Generate form's inputs, read by flushFileDeletes (declared before draftForm)
  const cloudFormPubRef = useRef(null);   // this browser's last cloud form publication {at, paths} (review wf_ec400a67-988 #6)
  const [failedSyncCount, setFailedSyncCount] = useState(0);

  // ─── AUTH HANDLERS ───
  // Initialize Supabase early so sign-in can reach the server right away
  useEffect(() => { if (isSupabaseConfigured()) initSupabase(); }, []);

  // Reconcile cached session username with the canonical one in _account settings.
  // Fixes a historical bug where login hardcoded "admin" in localStorage — after this
  // runs once, `getDeviceId()` returns `user:<real-username>` so data + backups are
  // correctly scoped and visible across devices.
  useEffect(() => {
    if (!isAuthed || !isSupabaseConfigured()) return;
    let cancelled = false;
    (async () => {
      try {
        if (!getSession()) return;
        await initSupabase();
        if (cancelled) return;
        // Auto-pull latest backup list so "Last backup" timestamp is live on load
        const list = await listBackups(20);
        if (!cancelled) setBackups(list);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [isAuthed]);

  function handleSignedIn(session) {
    // The data scope is the server's spelling of the username (getDeviceId() -> "user:<username>").
    setSession(session);
    resetDeviceIdCache();
    setSessionNotice("");
    setSessionRefusal("");
    setJoinLink(null);
    bindPageAccount(tokenAccountId(session?.token));
    setIsAuthed(true);
  }

  async function handleLogout() {
    if (!confirm("Sign out? Your data will remain safely in the cloud — sign back in any time.")) return;
    // Let an already-queued favorites write finish while the current account scope
    // is still active. A failed write remains in the scoped retry queue.
    try { await favoriteSyncChainRef.current; } catch {}
    signOutLocal();
  }

  // Ends the session on this device. Running polls stop (their tasks stay "processing" in IndexedDB and
  // resume after the next sign-in, within the 48-hour window).
  function signOutLocal() {
    clearSession();
    bindPageAccount(null);
    resetDeviceIdCache();
    for (const id of Object.keys(pollRefs.current)) clearTimeout(pollRefs.current[id]);
    pollRefs.current = {};
    // Clear in-memory state so next login re-fetches fresh
    setIsAuthed(false);
    setTasks([]);
    setLogs([]);
    setSelectedModels([]);
    const emptyFavorites = emptyModelFavorites();
    favoriteModelsRef.current = emptyFavorites;
    favoriteModelsUpdatedAtRef.current = 0;
    setFavoriteModelsByType(emptyFavorites);
    setKeyStatus("unknown");
    setKeyInput("");
    setBalance(null);
    setPage("cockpit");
    savedLogIds.current.clear();
    savedTaskIds.current.clear();
    initialLoadDone.current = false;
    taskSyncQueueRef.current = [];
  }

  // Session expiry: an RPC or the proxy rejected the token, or its 12 hours ran out on this device.
  const expireSessionRef = useRef(null);
  expireSessionRef.current = () => {
    if (!isAuthed) return;
    signOutLocal();
    setSessionNotice("Your session expired — sign in again.");
  };
  useEffect(() => {
    onSessionExpired(() => expireSessionRef.current?.());
    return () => onSessionExpired(null);
  }, []);
  useEffect(() => {
    if (!isAuthed) return;
    // Review r8 #6: a storage event can be missed, and a cancelled reload must not keep a foreign session: checked here too.
    const check = () => {
      if (!getSession()) expireSessionRef.current?.();
      else if (pageMustLeave({ authed: isAuthedRef.current, pageAccount: pageAccountId(), token: getSession()?.token, stored: readBrowserAccount() })) leavePage();
    };
    const id = setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", check); };
  }, [isAuthed]);

  // Load state from IndexedDB + Supabase (gated on authentication)
  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    (async () => {
      await migrateFromLocalStorage();
      if (cancelled) return;

      // Load local data first (fast)
      const favoriteScope = getDeviceId();
      rekeyFavoriteRetries(favoriteScope);   // a retry queued before a rename follows the account to its new name
      // `let`: a Reset voided later puts its favorites back below (applyClearStashes, review round 15 S3).
      let localFavoriteValue = await getSetting(localModelFavoritesKey(favoriteScope));
      let localFavoriteSnapshot = readModelFavoritesSetting(localFavoriteValue);
      if (!cancelled) {
        favoriteModelsRef.current = localFavoriteSnapshot.byType;
        favoriteModelsUpdatedAtRef.current = localFavoriteSnapshot.updatedAt;
        setFavoriteModelsByType(localFavoriteSnapshot.byType);
      }
      // The WaveSpeed key lives on the server now: drop any copy an older build left in this browser.
      if (await getSetting("apiKey")) setSetting("apiKey", "");
      removeFailedSync("setting", "apiKey");
      refreshBalance().catch(() => {});
      refreshProviderKeys();
      const logData = await getHistory(500);
      if (logData?.length && !cancelled) {
        // Already stored: the save effect walks every entry and would otherwise upload all of them again on each load
        // (one never uploaded is still in the failed-sync queue, and the reconcile pass uploads local-only entries).
        for (const l of logData) savedLogIds.current.add(l.id);
        setLogs(logData);
      }
      const savedTasks = await getCompletedTasks(500);
      if (savedTasks?.length && !cancelled) {
        for (const t of savedTasks) savedTaskIds.current.add(t.id);
        // Merge, never replace: the resume effect's read resolves first and has already put the resumed
        // tasks in state. Replacing dropped them, so their results were never saved.
        setTasks(prev => mergeLoadedTasks(prev, savedTasks));
      }
      const savedImgRes = await getSetting("defaultImageRes");
      if (savedImgRes && !cancelled) setDefaultImageRes(savedImgRes);
      const savedVidDur = await getSetting("defaultVideoDur");
      if (savedVidDur && !cancelled) setDefaultVideoDur(Number(savedVidDur));
      // Theme + background settings (also synced to Supabase so they follow you across devices)
      const savedTheme = await getSetting("theme");
      if (savedTheme && !cancelled) setThemeState(savedTheme);
      const savedBg = await getSetting("background");
      if (savedBg && !cancelled) setBackgroundState(savedBg === "void" ? "orbs" : savedBg);
      const savedLight = await getSetting("lightMode");
      if (savedLight != null && !cancelled) setLightModeState(savedLight === "1" || savedLight === "true");


      // Then pull cloud data and merge (fills any gaps from other devices / recovery)
      await initSupabase();
      if (cancelled || !isSupabaseConfigured()) return;
      let restoreKnown = false;   // whether the replay below may send delete intents (restoreGuard)
      try {
        // Guard: flush any pending debounced writes BEFORE pulling cloud to avoid
        // a stale pre-bootstrap write landing after we've loaded fresh cloud data.
        bootstrapInProgress.current = true;
        if (taskSyncTimerRef.current) {
          clearTimeout(taskSyncTimerRef.current);
          taskSyncTimerRef.current = null;
          const queue = taskSyncQueueRef.current.splice(0);
          if (queue.length > 0) { try { await sendTasks(queue); } catch { for (const t of queue) addFailedSync({ kind: "task", id: t.id, data: t }); } }
        }
        const restoreKnownAt = knownRestoreAt();   // task B18 review: what this browser knew before the reads
        const remote = await pullAllRemoteData();
        if (cancelled || !remote) { bootstrapInProgress.current = false; return; }

        // Pre-load pending bulk-delete intents into the deleting-guards BEFORE merging the
        // cloud pull, so rows the user already deleted (whose cloud delete hasn't confirmed
        // yet) are NOT re-seeded into local state/IndexedDB. The replay block below still
        // runs the actual cloud delete and clears the intents on success.
        // A restore on any device voids the intents queued here before it, and that runs first (review rounds 2 and
        // 3): only the survivors are marked, so what the restore brought back merges in below and its WaveSpeed copy is
        // held. Unreadable settings: nothing is voided and no delete intent is replayed this pass.
        const guard = restoreGuard(remote.settings);
        restoreKnown = guard.known;
        for (const id of guard.voided.task) deletingIds.current.delete(id);
        for (const id of guard.voided.history) deletingLogIds.current.delete(id);
        const stashBack = guard.restoreAt > 0 ? applyClearStashes(at => at < guard.restoreAt) : null;   // clears that restore voided (round 14)
        // A voided Reset's favorites came back: they are this device's local favorites for the choice below (round 15 S3).
        if (stashBack?.favorites) { localFavoriteValue = stashBack.favorites; localFavoriteSnapshot = readModelFavoritesSetting(stashBack.favorites); }
        for (const id of guard.pending.task) deletingIds.current.add(id);
        for (const id of guard.pending.history) deletingLogIds.current.add(id);

        // Merge tasks: add any cloud tasks not already in local (and not pending-delete)
        if (remote.tasks?.length > 0) {
          setTasks(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const newOnes = remote.tasks.filter(t => !existingIds.has(t.id) && !deletingIds.current.has(t.id));
            // Save new cloud tasks to local IndexedDB. A running one is not "saved": when this device's poll finishes
            // it, the result must still be stored and uploaded.
            for (const t of newOnes) {
              if (!isInFlight(t)) savedTaskIds.current.add(t.id);
              saveTask(t);
            }
            return [...newOnes, ...prev].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
          });
          if (remote.tasks.some(isInFlight)) setTimeout(pollUntracked, 1000); // running on another device: poll it here too
        }

        // Merge history: add any cloud logs not already in local (and not pending-delete)
        if (remote.history?.length > 0) {
          setLogs(prev => {
            const existingIds = new Set(prev.map(l => l.id));
            const newOnes = remote.history.filter(l => !existingIds.has(l.id) && !deletingLogIds.current.has(l.id));
            for (const l of newOnes) {
              savedLogIds.current.add(l.id);
              addHistoryEntry(l);
            }
            return [...newOnes, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          });
        }
        // A restore this device had not handled yet: the cloud's copy of every entry both sides hold wins (restoreGuard,
        // review round 3). Marked handled only once History answered, so a failed read retries on the next pass.
        // Task B18 review (b18 #1): and only for a restore this browser knew before the reads: a newer one may have
        // committed after History was read. Then the first reconcile pass (started below) handles it, and nothing
        // rewrites an entry meanwhile (restorePendingRef).
        const restoreReady = guard.fresh && remote.historyOk && guard.restoreAt <= restoreKnownAt;
        restorePendingRef.current = guard.fresh && !restoreReady;
        if (restoreReady) {
          const pendingLogs = new Set(getFailedSyncs().filter(f => f.kind === "history").map(f => f.id));
          setLogs(prev => {
            const take = new Map(restoredVersions(prev, remote.history, pendingLogs).map(l => [l.id, l]));
            for (const l of take.values()) { savedLogIds.current.add(l.id); addHistoryEntry(l); }
            return take.size ? prev.map(l => take.get(l.id) || l) : prev;
          });
          markRestoreSeen(guard.restoreAt);
        }

        // Favorites are a versioned per-category setting. A queued local write is
        // always newest; otherwise the latest timestamp wins across devices.
        const pendingFavoriteWrite = getFailedSyncs().find(f => f.kind === "model-favorites" && f.scope === favoriteScope);
        const remoteFavoriteValue = remote.settings?.[MODEL_FAVORITES_SETTING];
        const remoteFavoriteSnapshot = readModelFavoritesSetting(remoteFavoriteValue);
        let chosenFavoriteSnapshot = localFavoriteSnapshot;
        if (pendingFavoriteWrite?.data) {
          chosenFavoriteSnapshot = readModelFavoritesSetting(pendingFavoriteWrite.data);
        } else if (remoteFavoriteValue != null && (localFavoriteValue == null || remoteFavoriteSnapshot.updatedAt > localFavoriteSnapshot.updatedAt)) {
          chosenFavoriteSnapshot = remoteFavoriteSnapshot;
        }
        favoriteModelsRef.current = chosenFavoriteSnapshot.byType;
        favoriteModelsUpdatedAtRef.current = chosenFavoriteSnapshot.updatedAt;
        setFavoriteModelsByType(chosenFavoriteSnapshot.byType);
        if (pendingFavoriteWrite?.data || (remoteFavoriteValue != null && chosenFavoriteSnapshot === remoteFavoriteSnapshot)) {
          setSetting(localModelFavoritesKey(favoriteScope), createModelFavoritesSetting(chosenFavoriteSnapshot.byType, chosenFavoriteSnapshot.updatedAt));
        }

        // Merge settings: cloud wins for keys not set locally
        if (remote.settings) {
          if (!savedImgRes && remote.settings.defaultImageRes) { setDefaultImageRes(remote.settings.defaultImageRes); setSetting("defaultImageRes", remote.settings.defaultImageRes); }
          if (!savedVidDur && remote.settings.defaultVideoDur) { setDefaultVideoDur(Number(remote.settings.defaultVideoDur)); setSetting("defaultVideoDur", remote.settings.defaultVideoDur); }
        }
      } catch {}
      // Bootstrap complete — allow persistence effect to schedule writes again
      bootstrapInProgress.current = false;
      // Replay any failed syncs from previous sessions
      if (!cancelled) {
        const failed = getFailedSyncs();
        setFailedSyncCount(failed.length);
        if (failed.length > 0) {
          // Resolve deletes vs upserts up front: a task with BOTH a pending upsert and a
          // pending delete must end up DELETED. Mark these ids as deleting so neither this
          // replay nor the session's persistence effect re-uploads them.
          const delRetries = failed.filter(f => f.kind === "task-delete").map(f => f.id).filter(Boolean);
          const delSet = new Set(delRetries);
          for (const id of delRetries) deletingIds.current.add(id);
          const logDelRetries = failed.filter(f => f.kind === "history-delete").map(f => f.id).filter(Boolean);
          const logDelSet = new Set(logDelRetries);
          for (const id of logDelRetries) deletingLogIds.current.add(id);
          // Replay deferred bulk-deletes FIRST (review round 7: a History rewrite replayed before its delete would leave
          // the server no item to record a History-only generation's user tombstone from). The bootstrap pull above may
          // have re-fetched these rows from the cloud, so on a confirmed remote delete we also scrub them back out of
          // local state + IndexedDB (awaited) to prevent zombie rows. Only when the restore time was read (restoreGuard):
          // otherwise they wait for a pass that can tell whether a restore voided them. The server checks again,
          // atomically with the delete (replayDeleteIntents).
          if (restoreKnown) { await replayDeleteIntents("task-delete"); await replayDeleteIntents("history-delete"); settleClearStashes(); }
          // Round 19 #2: nor one whose delete was confirmed (a give-back may have put it back after the confirm).
          const taskRetries = withoutConfirmedUploads(failed.filter(f => f.kind === "task" && !delSet.has(f.id) && !deletingIds.current.has(f.id))).map(f => f.data).filter(Boolean);
          if (taskRetries.length > 0) {
            try {
              for (const t of await sendTasks(taskRetries)) removeFailedSync("task", t.id, sentVersion(t));
            } catch {}
          }
          await replayHistoryUploads(failed.filter(f => f.kind === "history" && !logDelSet.has(f.id) && !deletingLogIds.current.has(f.id)));
          const settingRetries = failed.filter(f => f.kind === "setting" && f.id !== "apiKey");
          for (const s of settingRetries) {
            try { await syncSetting(s.id, s.data); removeFailedSync("setting", s.id); } catch {}
          }
          const favoriteRetries = failed.filter(f => f.kind === "model-favorites" && f.scope === favoriteScope);
          if (favoriteRetries.length > 0) {
            try { await flushQueuedModelFavorites(favoriteScope); } catch {}
          }
          setFailedSyncCount(getFailedSyncs().length);
        }
      }
      // Mark initial load complete so later setting changes debounce-sync to cloud
      if (!cancelled) initialLoadDone.current = true;
      // First cross-device reconcile: drops rows deleted on other devices, adds theirs.
      if (!cancelled) reconcileWithCloud();
    })();
    return () => { cancelled = true; };
  }, [isAuthed]);

  // ─── Cross-device sync ───
  // Brings this device in line with the cloud (rules in src/lib/syncReconcile.js): adds rows other
  // devices created, refreshes archived outputs, removes rows the server recorded as deleted, and
  // uploads local rows the cloud never received. Runs after bootstrap, on focus / visibility /
  // reconnect, every 20s while visible, and on Supabase realtime changes.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const reconcileRunningRef = useRef(false);
  // True once a reconcile pass this session got History from the cloud (or 2 minutes passed without an answer):
  // History entries are finished only then.
  const [historySyncReady, setHistorySyncReady] = useState(false);
  // True while a restore this tab has not handled waits for History to answer (reconcile): nothing rewrites an entry
  // from a pre-restore copy meanwhile (review round 4).
  const restorePendingRef = useRef(false);
  // Task B18 verification (regression #2): bumped once a pass handled a restore, so the finishLogs effect (gated on the ref
  // above, which is not state) runs again even when that pass changed nothing else.
  const [restoreSettled, setRestoreSettled] = useState(0);
  const inputBackfillDone = useRef(false);   // the once-per-load input-URL backfill (reconcile)
  const resyncAppliedRef = useRef(new Set());   // task B12b: the History re-sync records this tab applied (reconcile)
  // True only once the cloud really answered this session (not by the 2-minute fallback below): the file queue
  // (fileDelete.js) acts only then, when this device knows which queued paths a kept generation still uses.
  const cloudSyncedRef = useRef(false);
  useEffect(() => { if (!isAuthed) { setHistorySyncReady(false); cloudSyncedRef.current = false; } }, [isAuthed]); // a later sign-in waits for its own sync
  // A session whose cloud never answers (offline, bootstrap failed) still finishes its entries after 2 minutes; the
  // server keeps any item the cloud records as completed, and the next pass that answers heals this copy.
  useEffect(() => {
    if (!isAuthed || historySyncReady) return;
    const id = setTimeout(() => setHistorySyncReady(true), 120000);
    return () => clearTimeout(id);
  }, [isAuthed, historySyncReady]);
  const reconcileWithCloud = useCallback(async () => {
    if (!isSupabaseConfigured() || !initialLoadDone.current || bootstrapInProgress.current || reconcileRunningRef.current) return;
    reconcileRunningRef.current = true;
    try {
      // The server must still accept this session before anything uploads: after a rename on another device,
      // this one would otherwise re-upload its rows under the old name (the server also refuses to move them).
      if (!(await checkSession())) return;
      const since = serverNow();   // the pass start in server time (the plans' grace window, recoverable failures)
      // Task B7a (round 20 #4): "confirmed before this pass" is decided by the shared confirm sequence, not by a clock
      // whose offset may move during the pass: a delete confirmed after this point is never released by this pass.
      const sinceSeq = confirmSeqNow();
      // Task B9 (review round 22 #4/#6): the restore this browser knows of before the reads below, so they show the cloud
      // after it: the confirms it superseded are decided by them (sharedDeleteState).
      const restoreKnownAt = knownRestoreAt();
      const [remote, ids] = await Promise.all([pullAllRemoteData(), pullCloudIds()]);
      if (!remote) return;
      // A restore on any device voids the delete intents queued here before it (review round 2): their ids are no
      // longer being deleted, so the rows it brought back can return to this device.
      const guard = restoreGuard(remote.settings);
      for (const id of guard.voided.task) deletingIds.current.delete(id);
      for (const id of guard.voided.history) deletingLogIds.current.delete(id);
      if (guard.restoreAt > 0) applyClearStashes(at => at < guard.restoreAt);   // clears that restore voided (round 14)
      // A restore this tab had not handled yet (review rounds 4 and 5): until History and the cloud ids both answer,
      // this pass decides nothing, so no step below rewrites an entry from a pre-restore copy and the restore is not
      // marked handled before its rows can be released; finishLogs waits too (restorePendingRef).
      // Task B18 review (b18 #1): the same while the restore is newer than what this browser knew before the reads (it may
      // have committed after History was read and before settings was): the next pass, whose reads all follow it, runs
      // in a second instead of waiting for the 20-second timer.
      const restoreAfterReads = guard.fresh && guard.restoreAt > restoreKnownAt;
      // Task B18 verification round 2 (correctness #1): finishLogs waits for the whole of a pass that handles a restore
      // (cleared right after markRestoreSeen below): a render during this pass's awaits would otherwise upload an entry's
      // pre-restore copy, and restoredVersions then leaves that entry (queued) as it is.
      restorePendingRef.current = guard.fresh;
      if (guard.fresh && (!remote.historyOk || !ids || restoreAfterReads)) {
        if (restoreAfterReads && remote.historyOk && ids) setTimeout(() => reconcileWithCloud(), 1000);
        return;
      }
      // Task B7a (round 20 #8): this tab's "being deleted" ids follow the shared queue and its own running calls.
      pruneDeleting();
      // Task B7a (round 20 #1, #3, #5): the SHARED delete state decides this pass, not this tab's sets alone (another tab
      // may have deleted a row this stale tab still holds). Deletes confirmed (in any tab) before this pass began whose
      // rows the cloud holds again came back by a restore: released for every tab (releaseRestored, review round 5).
      // Every other confirmed id, and every id with a delete intent pending in any tab, is being deleted for the plans.
      // Task B9 (review round 22 #4/#6): a confirm queued before a restore this browser knew of is decided by the cloud
      // after that restore: a generation it holds as a task row, as an item of a History entry, or as the restore's own
      // removal (by_restore tombstone, History-only) came back and is released; one absent from all of them stays deleted.
      const cloudItemIds = remote.historyOk ? (remote.history || []).flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : [])).map(i => i?.id).filter(Boolean) : null;
      const restoreRemoved = ids?.taskRestoreRemoved instanceof Set ? ids.taskRestoreRemoved : null;
      const taskDel = sharedDeleteState("task", { deleting: deletingIds.current, cloudIds: ids?.tasks ?? null, sinceSeq, restoreKnownAt,
        evidence: { present: [...(cloudItemIds || []), ...(restoreRemoved || [])], complete: !!cloudItemIds && !!restoreRemoved } });
      const logDel = sharedDeleteState("history", { deleting: deletingLogIds.current, cloudIds: ids?.history ?? null, sinceSeq, restoreKnownAt });
      for (const id of taskDel.released) deletingIds.current.delete(id);
      for (const id of logDel.released) deletingLogIds.current.delete(id);
      // Task B12b (simulator F1): a FINAL confirm whose row shows up in the cloud again without a restore (a late upload
      // landed after the delete) is not released: it keeps blocking the id in every tab, and it is deleted again. Its
      // delete intent is queued at the confirm's queue time, or at the restore this browser knew of before the reads if
      // that is later (storage.js sharedDeleteState): the server voids it if a restore newer than that exists (a row a
      // restore brought back is never deleted here; the void supersedes the confirm and the next pass decides from the
      // cloud). Only when no restore was learned during this pass (its reads show the cloud after every restore known).
      // The intents replay like every queued delete (Save, reload), restore-checked.
      if (restoreKnownAt >= knownRestoreAt()) {
        for (const [kind, st] of [["task-delete", taskDel], ["history-delete", logDel]]) {
          const byAt = new Map();
          for (const { id, at } of st.reappeared || []) { if (!byAt.has(at)) byAt.set(at, []); byAt.get(at).push(id); }
          for (const [at, list] of byAt) queueDeleteIntents(kind, list, at);
        }
      }
      // The cloud's copy of every shared entry wins (as at startup); the ref is updated at once, because steps below in
      // this pass (dropLogItemsFor, finishLogs input) read it. Task B19 (B18 verification round 3, correctness #1): this
      // comes BEFORE the stale step below, which rewrites and uploads this tab's entries (dropLogItemsFor -> persistLog): from
      // a pre-restore copy, that upload replaced the restored entry, and the queued upload then kept restoredVersions off it.
      if (guard.fresh) {
        const queuedLogs = new Set(getFailedSyncs().filter(f => f.kind === "history").map(f => f.id));
        const take = new Map(restoredVersions(logsRef.current, remote.history, queuedLogs).map(l => [l.id, l]));
        if (take.size) {
          for (const l of take.values()) { savedLogIds.current.add(l.id); addHistoryEntry(l); }
          logsRef.current = logsRef.current.map(l => take.get(l.id) || l);
          setLogs(prev => prev.map(l => take.get(l.id) || l));
        }
        markRestoreSeen(guard.restoreAt);
        restorePendingRef.current = false;
        setRestoreSettled(n => n + 1);
      }
      // Delete means delete in every tab: this tab's copy of a row whose delete was confirmed and that the cloud lacks goes
      // (state and IndexedDB). Its WaveSpeed copy and files were handled by the tab that deleted it, from ITS view: task
      // B13b re-plans them below against this tab's (elsewherePurge).
      const logsBeforeDrops = logsRef.current;   // task B13b: the History these removals start from
      const staleTasks = new Set(taskDel.stale(tasksRef.current)), staleLogs = new Set(logDel.stale(logsRef.current));
      const staleTaskRows = tasksRef.current.filter(t => staleTasks.has(t.id));
      if (staleTasks.size) {
        tasksRef.current = tasksRef.current.filter(t => !staleTasks.has(t.id));
        setTasks(prev => prev.filter(t => !staleTasks.has(t.id)));
        for (const id of staleTasks) { savedTaskIds.current.delete(id); recoveringIds.current.delete(id); clearTimeout(pollRefs.current[id]); delete pollRefs.current[id]; }
        taskSyncQueueRef.current = taskSyncQueueRef.current.filter(t => !staleTasks.has(t.id));
        await deleteTasks([...staleTasks]);
      }
      if (staleLogs.size) {
        logsRef.current = logsRef.current.filter(l => !staleLogs.has(l.id));
        setLogs(prev => prev.filter(l => !staleLogs.has(l.id)));
        for (const id of staleLogs) savedLogIds.current.delete(id);
        await deleteHistoryEntries([...staleLogs]);
      }
      // Task B8a (review round 21 #1/#5): their History here too. The deleting tab removed its own entries, but one whose
      // items all carry ids got no History intent there (the server's work), so this tab's copy would be uploaded again
      // with the deleted item. The items of those tasks, and of every other confirmed task the cloud lacks that this tab
      // holds only in History, leave its entries as the deleting tab's did: an entry keeping other items is rewritten, an
      // emptied one gets its own History delete (dropLogItemsFor), all before History is planned below.
      const staleItemIds = taskDel.stale(logsRef.current.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : [])).filter(i => i?.id))
        .filter(id => !staleTasks.has(id));
      const staleGone = [...staleTaskRows, ...[...new Set(staleItemIds)].map(id => ({ id }))];
      if (staleGone.length) dropLogItemsFor(staleGone);
      const failed = getFailedSyncs();
      const pendingTasks = new Set([...failed.filter(f => f.kind === "task").map(f => f.id), ...taskSyncQueueRef.current.map(t => t.id)]);
      const pendingLogs = new Set(failed.filter(f => f.kind === "history").map(f => f.id));
      // Task B12b (simulator F3): the History entries a delete trimmed here take the cloud's copy once that delete settled
      // (storage.js historyResyncDue), whether it was confirmed (the cloud's copy is stripped the same way: no change) or
      // voided after this tab had handled the restore (the cloud's entry kept the items; the trimmed copy stayed here for
      // good, and the restoredVersions step above runs only for a restore not handled yet). Items of FINAL deletes are
      // left out (gone for good). An entry holding an item whose delete is still undecided (pending, in a call, a
      // superseded confirm, this tab's own), one with an upload queued here (pendingLogs), or one being deleted waits:
      // its record is applied by a later pass, once they settle (taken minus an undecided item, a void of that item would
      // leave the entry short for good). Each record once per tab, once every entry of it was decided.
      if (remote.historyOk) {
        const due = historyResyncDue().filter(r => !resyncAppliedRef.current.has(r.key));
        if (due.length) {
          const want = new Set(due.flatMap(r => r.ids));
          const undecided = (id) => taskDel.deleting.has(id) && !taskDel.final.has(id);
          const waits = new Set([...want].filter(id => pendingLogs.has(id) || logDel.deleting.has(id)));
          const cloudCopies = [];
          for (const c of remote.history || []) {
            if (!c?.id || !want.has(c.id) || waits.has(c.id)) continue;
            const items = Array.isArray(c.tasks) ? c.tasks : [];
            if (items.some(i => i?.id && undecided(i.id))) { waits.add(c.id); continue; }
            cloudCopies.push({ ...c, tasks: items.filter(i => !(i?.id && taskDel.final.has(i.id))) });
          }
          const take = new Map(restoredVersions(logsRef.current.filter(l => want.has(l.id)), cloudCopies, pendingLogs).map(l => [l.id, l]));
          if (take.size) {
            for (const l of take.values()) { savedLogIds.current.add(l.id); addHistoryEntry(l); }
            logsRef.current = logsRef.current.map(l => take.get(l.id) || l);
            setLogs(prev => prev.map(l => take.get(l.id) || l));
          }
          for (const r of due) if (!r.ids.some(id => waits.has(id))) resyncAppliedRef.current.add(r.key);
        }
      }
      const taskPlan = planTaskSync({ local: tasksRef.current, cloud: remote.tasks || [], cloudIds: ids?.tasks ?? null,
        tombstones: ids?.taskTombstones ?? null, pending: pendingTasks, deleting: taskDel.deleting, since });
      // Older cloud rows get the input URLs this device holds (inputBackfill, review rounds 3 and 4): their cloud copies
      // are read by id, whatever their age (the sync pulls only the newest 500), once per page load; a failed read or
      // write leaves it for the next pass. Nothing is queued.
      if (!inputBackfillDone.current) {
        inputBackfillDone.current = true;
        const candidates = tasksRef.current.filter(t => !deletingIds.current.has(t.id)
          && (t.endFrameUrl || t.sourceAudioUrl || t.sourceVideoUrl || t.refVideoUrl));
        (async () => {
          const cloud = candidates.length ? await pullTaskInputs(candidates.map(t => t.id)) : [];
          const rows = cloud ? inputBackfill(candidates, cloud) : null;
          const r = rows === null ? { ok: false } : rows.length ? await backfillTaskInputs(rows) : { ok: true };
          if (!r.ok) inputBackfillDone.current = false;
        })().catch(() => { inputBackfillDone.current = false; });
      }
      const logPlan = planLogSync({ local: logsRef.current, cloud: remote.history || [], cloudIds: ids?.history ?? null,
        tombstones: ids?.historyTombstones ?? null, pending: pendingLogs, deleting: logDel.deleting, since });
      const rmTasks = new Set(taskPlan.remove), rmLogs = new Set(logPlan.remove);
      const updates = new Map(taskPlan.update.map(u => [u.id, u]));
      let userRemovedHere = [];   // task B13b: the tasks a user deleted elsewhere that this pass removes (rmTasks below)

      // History entries still open here that another device already finished take that outcome first, so the steps
      // below never close or finish them from this device's stale tasks (batchLog.js takeFinishedFromCloud). The
      // cloud has them already: stored locally only.
      const logsFromCloud = takeFinishedFromCloud(logsRef.current, remote.history || []).filter(l => !logDel.deleting.has(l.id));
      if (logsFromCloud.length) {
        const byId = new Map(logsFromCloud.map(l => [l.id, l]));
        logsRef.current = logsRef.current.map(l => byId.get(l.id) || l); // dropLogItemsFor below reads the ref
        setLogs(prev => prev.map(l => byId.get(l.id) || l));
        for (const l of logsFromCloud) { savedLogIds.current.add(l.id); addHistoryEntry(l); }
      }
      // History answered and the cloud's finished entries are merged: this device may finish entries now.
      if (remote.historyOk) { cloudSyncedRef.current = true; setHistorySyncReady(true); }

      // Tasks: the cloud's additions + archive updates + outcomes other devices saved, and the server's recorded deletions.
      if (taskPlan.add.length || updates.size || rmTasks.size) {
        // Pulled rows are already in the cloud; a running one is not "saved" yet (this device may finish it).
        for (const t of taskPlan.add) if (!isInFlight(t)) savedTaskIds.current.add(t.id);
        setTasks(prev => {
          const have = new Set(prev.map(t => t.id));
          const added = taskPlan.add.filter(t => !have.has(t.id) && !deletingIds.current.has(t.id));
          const kept = prev.filter(t => !rmTasks.has(t.id)).map(t => updates.has(t.id) ? applyCloudUpdate(t, updates.get(t.id)) : t);
          return [...added, ...kept].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        });
        for (const t of taskPlan.add) saveTask(t);
        for (const t of tasksRef.current) {
          const u = updates.get(t.id);
          if (!u) continue;
          const next = applyCloudUpdate(t, u);
          if (u.finish && next !== t) {
            // Another device saved this result: stop polling it here, and don't upload it back.
            clearTimeout(pollRefs.current[t.id]); delete pollRefs.current[t.id];
            savedTaskIds.current.add(t.id); recoveringIds.current.delete(t.id);
          }
          if (next !== t) saveTask(next);
        }
        if (taskPlan.add.some(isInFlight)) setTimeout(pollUntracked, 500);
        if (rmTasks.size) {
          // Deleted on another device: the delete wins over any stale local upload of the same row, and a running
          // one stops polling here. Their prediction ids are released (no lost submit may adopt them).
          const removedHere = tasksRef.current.filter(t => rmTasks.has(t.id));
          releasePredictions(removedHere.map(t => t.taskId));
          // Only a user's delete takes the History items (and a claimant's prediction) with it; a task a restore removed
          // keeps both (syncReconcile.js historyRemovals, review round 5).
          const userRemoved = historyRemovals(removedHere, ids?.taskRestoreRemoved ?? null);
          userRemovedHere = userRemoved;
          recordClaimants(userRemoved, { deleted: true });   // a claimant cancelled here and deleted elsewhere is deleted too (review #10)
          dropLogItemsFor(userRemoved);
          for (const id of rmTasks) {
            savedTaskIds.current.delete(id); removeFailedSync("task", id);
            clearTimeout(pollRefs.current[id]); delete pollRefs.current[id];
          }
          await deleteTasks([...rmTasks]);
        }
      }
      // History items of generations a user deleted elsewhere that this device holds no task of (History-only, e.g. after a
      // restore) go too: their ids carry a user tombstone (syncReconcile.js tombstonedItems, review round 6).
      const goneItems = tombstonedItems(logsRef.current, ids?.taskTombstones ?? null, ids?.taskRestoreRemoved ?? null,
        new Set(tasksRef.current.map(t => t.id)));
      if (goneItems.length) dropLogItemsFor(goneItems.map(id => ({ id })));
      // Task B16 (migration 20261024100000, K2): items of generations a restore removed that the cloud's copy of their entry
      // lacks (the server stripped them from a late upload) leave this tab's copy too; the cloud already holds that shape.
      // Task B18 (review round 30 #8): History and the tombstones are read in parallel. A restore that committed between those
      // reads shows its removals in the tombstones while History is from before it: the strip would drop, for good, an item
      // the restore brought back History-only. So when there is something to strip, the marker is read again first; if it
      // moved since this pass's settings read, the strip waits for the next pass (which reads History after that restore).
      // Computed again after the await, from this tab's copies as they are then.
      const stripCandidates = remote.historyOk ? restoreStrippedLogs(logsRef.current, remote.history || [], ids?.taskRestoreRemoved ?? null) : [];
      // Task B18 review (b18 #1): and only for a marker this browser knew before the reads (History then follows it).
      const markerSame = !stripCandidates.length || (guard.restoreAt <= restoreKnownAt && (await pullRestoreAt()) === guard.restoreAt);
      const stripped = markerSame && stripCandidates.length
        ? restoreStrippedLogs(logsRef.current, remote.history || [], ids?.taskRestoreRemoved ?? null) : [];
      if (stripped.length) {
        const byId = new Map(stripped.map(l => [l.id, l]));
        logsRef.current = logsRef.current.map(l => byId.get(l.id) || l);
        setLogs(prev => prev.map(l => byId.get(l.id) || l));
        for (const l of stripped) { savedLogIds.current.add(l.id); addHistoryEntry(l); }
      }
      // Task B13b (simulator classes A and C): what a user deleted ELSEWHERE and this pass just removed (another tab's
      // final confirm: the stale rows and History items; another device's: the user-tombstoned rows and History-only
      // items) is re-planned here against THIS tab's kept view, once its History drops are done. The deleting device
      // planned the files from its own view: a batch input a sibling still used there was kept, and when two devices each
      // delete one sibling while the other still shows, nobody planned the shared file again (A). Their paths that no
      // generation or entry kept here uses are queued; the flush still keeps one a kept generation, a hold, a stash, a form
      // or a cloud row uses. And the WaveSpeed result of such a generation is deleted by the device that holds its
      // prediction id (C): another device, or a History-only view, never had it. Queued through deleteOnWaveSpeed (held if
      // this browser's own delete of it is still undecided; dedup in the queue); the flush still keeps a prediction a cloud
      // row or a live generation holds (predictions_in_use, generations_live). A History-only generation's prediction id
      // comes from its History item (batchLog.js itemOf carries it since B13b): no device may hold its task any more.
      {
        const itemsBefore = new Map(logsBeforeDrops.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : [])).filter(i => i?.id).map(i => [i.id, i]));
        const goneHere = [...staleTaskRows, ...userRemovedHere];
        const goneHereIds = new Set(goneHere.map(t => t.id));
        for (const id of [...staleItemIds, ...goneItems]) if (!goneHereIds.has(id)) { goneHereIds.add(id); goneHere.push(itemsBefore.get(id) || { id }); }
        if (goneHere.length) {
          const { paths, ws } = elsewherePurge({ gone: goneHere, logsBefore: logsBeforeDrops,
            keptTasks: [...tasksRef.current.filter(t => !rmTasks.has(t.id) && !goneHereIds.has(t.id)), ...taskSyncQueueRef.current],
            keptLogs: logsRef.current.filter(l => !rmLogs.has(l.id)) });
          queueArchivedFileDeletes(paths);
          if (ws.length) deleteOnWaveSpeed(ws, { flush: false });   // the pass flushes both queues once React applied it
        }
      }
      // Local-only tasks the cloud never received (failed or evicted uploads, finished during load,
      // pre-sync rows): persist + queue them like a fresh result, then upload. Capped per pass so the
      // 200-entry failed-sync queue never evicts other pending writes.
      // Task B7a: through the shared filter first (uploadable), so nothing is saved back or queued for an id another tab
      // is deleting or deleted, and sent through sendTasks.
      const taskUploads = uploadable("task", taskPlan.upload.slice(0, 100));
      if (taskUploads.length) {
        for (const t of taskUploads) { savedTaskIds.current.add(t.id); saveTask(t); addFailedSync({ kind: "task", id: t.id, data: t }); }
        try { for (const t of await sendTasks(taskUploads)) removeFailedSync("task", t.id, sentVersion(t)); } catch {}
      }

      // History: same steps.
      if (logPlan.add.length || rmLogs.size) {
        for (const l of logPlan.add) savedLogIds.current.add(l.id);
        setLogs(prev => {
          const have = new Set(prev.map(l => l.id));
          const added = logPlan.add.filter(l => !have.has(l.id) && !deletingLogIds.current.has(l.id));
          return [...added, ...prev.filter(l => !rmLogs.has(l.id))].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
        for (const l of logPlan.add) addHistoryEntry(l);
        if (rmLogs.size) {
          for (const id of rmLogs) { savedLogIds.current.delete(id); removeFailedSync("history", id); }
          await deleteHistoryEntries([...rmLogs]);
        }
      }
      // None carries a generation whose delete is final (review round 9 guard, task B9): such an entry goes without it, and
      // one left with no item is not uploaded; one holding an item of a superseded confirm or of a call in flight waits
      // (storage.js historyUploadPlan). Task B7a: entries another tab is deleting or deleted are left out first (uploadable).
      const logUploads = historyUploadPlan(uploadable("history", logPlan.upload.slice(0, 100))).upload;
      if (logUploads.length) {
        for (const l of logUploads) { savedLogIds.current.add(l.id); addHistoryEntry(l); addFailedSync({ kind: "history", id: l.id, data: l }); }
        try { for (const l of await sendHistory(logUploads)) removeFailedSync("history", l.id, sentVersion(l)); } catch {}
      }
      // Review round 24 #1/#3/#5: the held files and WaveSpeed deletes of owners whose delete ended without a final confirm
      // (voided, dropped by a restore, a lapsed call) are decided by this pass's cloud reads, in the same step as the
      // superseded confirms above: an owner the cloud holds after the restore (a task row, an item of a History entry; a
      // History entry) or this tab keeps after this pass's plans is alive (its paths are kept), one absent from all of it
      // is gone (its paths and result are queued; the flushes' cloud checks still apply). Only when the reads began after
      // a restore newer than the hold and no newer one was learned meanwhile (storage.js releaseHeldPurges).
      // Task B12b (review round 25 #10): "this browser keeps it" is read from what EVERY tab shares, not only this tab's
      // memory: IndexedDB (another tab may have given the generation back from a voided clear into its state and IndexedDB
      // while this tab cleared it; storage.js storedEvidenceIds), the clear stashes and queued uploads (storedKeptIds, read
      // at the decision), plus this tab's state and debounced queue. IndexedDB unreadable: nothing is decided from absence.
      // Task B12b (review round 25 #3): complete evidence only. Tombstones unread: no decision. History read only up to its
      // newest HISTORY_PULL_LIMIT entries (capped): every owner the evidence would call gone is asked of the server first
      // (generations_live: a tasks row, or an item of a live History entry, of any age); unanswered: no decision.
      // Task B13a (simulator G; CLAUDE.md "a delete voided or dropped by a restore is decided by the cloud after that
      // restore: kept if the generation came back, deleted if it did not"): the restore's own removals (by_restore
      // tombstones) are NOT present here. Such a tombstone says the restore removed the generation (it was not in the
      // backup), so the generation did not come back and its files and WaveSpeed result go. A generation the restore
      // brought back History-only is present through the cloud's History items (cloudItemIds) and, at the History cap,
      // through generations_live. Before, counting them present kept those files and results forever.
      // The superseded-confirm step above keeps them as present: it decides only whether this browser keeps BLOCKING the
      // id (a released record lets the id be added and uploaded again, as the restore's own state then decides), never
      // files; there a wrong "deleted" would hide a History-only comeback at the cap, which that step does not ask the
      // server about.
      if (ids) {
        // Owner ruling 2026-10-23: a copy stored in IndexedDB of an id the cloud tombstones (a user's delete or the restore's
        // own removal) or that this pass removes is a leftover the next load removes, not a generation this browser keeps
        // (a cancelled clear's put-back may have stored one the restore then removed).
        const tombT = ids.taskTombstones instanceof Set ? ids.taskTombstones : new Set(), tombH = ids.historyTombstones instanceof Set ? ids.historyTombstones : new Set();
        // Task B18 verification (regression #1): the same for this tab's debounced upload queue. Its copy of an id this pass
        // removes or the cloud tombstones never lands (the server refuses it), so it does not keep that generation's files.
        const keptTaskIds = new Set([...tasksRef.current.filter(t => !rmTasks.has(t.id)).map(t => t.id),
          ...taskSyncQueueRef.current.filter(t => !rmTasks.has(t.id) && !tombT.has(t.id)).map(t => t.id)]);
        const keptLogs = logsRef.current.filter(l => !rmLogs.has(l.id));
        // Task B18 verification round 2 (regression #1): nor does this tab's History item of a generation the restore removed
        // (a by_restore tombstone): the server strips it from any upload when the stored entry lacks it (K2), and a stored
        // entry that holds it (a History-only comeback) counts through the cloud's items (cloudItemIds, generations_live).
        for (const l of keptLogs) for (const i of Array.isArray(l?.tasks) ? l.tasks : []) if (i?.id && !(tombT.has(i.id) && restoreRemoved?.has(i.id))) keptTaskIds.add(i.id);
        const keptLogIds = new Set(keptLogs.map(l => l.id));
        // Task B15 (review round 28 #5): this browser's stash and queue traces, read BEFORE IndexedDB too: a give-back that
        // drops its stash after this read wrote IndexedDB in a transaction created before it (saveTasksNow), so the
        // IndexedDB read below sees it; one that dropped it before this read is in IndexedDB already.
        const earlyKept = hasHeldPurges() ? storedKeptIds() : null;
        const shared = hasHeldPurges() ? await storedEvidenceIds() : null;
        if (shared) {
          for (const id of shared.task) if (!tombT.has(id) && !rmTasks.has(id)) keptTaskIds.add(id);
          for (const id of shared.history) if (!tombH.has(id) && !rmLogs.has(id)) keptLogIds.add(id);
        }
        if (earlyKept) {
          for (const id of earlyKept.task) if (!tombT.has(id)) keptTaskIds.add(id);
          for (const id of earlyKept.history) if (!tombH.has(id)) keptLogIds.add(id);
        }
        // Task B13b (simulator class D): with the ids the cloud says were deleted (user task tombstones, a restore's own
        // left out; History tombstones). An undecided owner another browser deleted is decided "gone" from them, without
        // waiting for a restore's evidence (storage.js heldPurgeRule), when nothing here or in the cloud keeps it.
        const userTaskTombstones = ids.taskTombstones instanceof Set && restoreRemoved ? [...ids.taskTombstones].filter(id => !restoreRemoved.has(id)) : [];
        // Task B18 verification round 3 (regression #1): the pass that handles a restore decides no held purge (-1: neither
        // "usable" nor "current" in storage.js heldPurgeRule); the next one does. With the 1-second re-run, the handling pass
        // would otherwise decide as soon as it learned the restore, before another device's queued upload of a generation
        // the restore removed History-only could land.
        const evidence = { restoreKnownAt: guard.fresh ? -1 : restoreKnownAt,
          task: { present: [...(ids.tasks || []), ...(cloudItemIds || [])], local: keptTaskIds, deleted: userTaskTombstones, tombstoned: [...tombT],
            complete: ids.tasks instanceof Set && !!cloudItemIds && !!restoreRemoved && !!shared },
          history: { present: [...(ids.history || [])], local: keptLogIds, deleted: ids.historyTombstones instanceof Set ? [...ids.historyTombstones] : [], tombstoned: [...tombH],
            complete: ids.history instanceof Set && !!shared } };
        if (evidence.task.complete && (remote.history || []).length >= HISTORY_PULL_LIMIT) {
          const candidates = heldGoneCandidates(evidence);
          const live = candidates.length ? await generationsLiveRemote(candidates) : new Set();
          if (live) evidence.task.present.push(...live); else evidence.task.complete = false;
        }
        releaseHeldPurges(Date.now(), evidence);
        applyRelinks();   // task B12b: a kept generation gets back a late result or archive whose hold was cancelled
      }
      setFailedSyncCount(getFailedSyncs().length);
      // The delete queues act on what this pass just merged, once React has applied it (review wf_ec400a67-988 #5).
      setTimeout(() => { flushWsDeletes(); flushFileDeletes(); }, 1500);
    } catch (err) {
      console.warn("[sync] reconcile failed", err);
    } finally {
      reconcileRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false, timer = null, unsubscribe = () => {};
    const run = () => { if (document.visibilityState === "visible") reconcileWithCloud(); };
    const soon = () => { clearTimeout(timer); timer = setTimeout(run, 500); }; // coalesce realtime bursts, focus + visibility
    const onVisibility = () => { if (document.visibilityState === "visible") soon(); };
    const interval = setInterval(run, 20000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", soon);
    window.addEventListener("online", soon);
    initSupabase().then(() => { if (!cancelled) unsubscribe = subscribeToCloudChanges(soon); });
    return () => {
      cancelled = true; clearInterval(interval); clearTimeout(timer); unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", soon);
      window.removeEventListener("online", soon);
    };
  }, [isAuthed, reconcileWithCloud]);

  // Stores a History entry locally and in the cloud, queued first like every cloud write. A confirmed upload clears
  // only the version it sent: a batch's open entry can resolve after its finished version replaced it in the queue.
  // Returns the upload, settled either way (a delete's toast waits for its rewrites, review round 2).
  const persistLog = useCallback((entry) => {
    // Task B7a: an entry another tab is deleting or deleted is neither stored back here nor uploaded (a stale copy).
    if (uploadBlockedIds("history").has(entry?.id)) return Promise.resolve();
    // Task B8a (review round 21 #1): nor an item of a task whose delete is FINAL. Stored here as given, queued and sent
    // without those items; an entry left with no item is only stored, and stays unsaved (it leaves with them: the
    // reconcile's stale step). Task B9 (review round 22 #5/#7): an item that is only PENDING deletion stays in the queued
    // copy and the upload (that delete's transaction strips it on the server; a void keeps it). An entry holding an item
    // of a superseded confirm or of a call in flight is queued as given and waits (sendHistoryEntry sends nothing): the
    // queue entry is cleared only by an upload that was sent.
    // Review round 23 #4: nor does it strip FINAL items on its own any more: it runs without a fresh restore read, and a
    // restore made elsewhere that no tab here has read yet may have brought the item back (the stripped copy then
    // overwrote the restored entry). Such an entry is queued as given and not sent, like a deferred one; the reconcile
    // pass (its stale step rewrites the entry, after restoreGuard) and the replays (restoreGuard first) strip and send it.
    const held = historyUploadPlan([entry], { strip: false }).defer.length > 0;
    const send = entry;
    addHistoryEntry(entry);
    savedLogIds.current.add(entry.id);
    addFailedSync({ kind: "history", id: send.id, data: send });
    setFailedSyncCount(getFailedSyncs().length);
    if (held) return Promise.resolve();
    return trackedSync(`history-${send.id}${isOpenLog(send) ? "-open" : ""}`, () => sendHistoryEntry(send, { strip: false }))
      .then((sent) => { if (sent?.length) removeFailedSync("history", send.id, e => sameLogContent(e.data, send)); setFailedSyncCount(getFailedSyncs().length); })
      .catch(() => { setFailedSyncCount(getFailedSyncs().length); });
  }, [trackedSync]);

  // A delete's History rewrites (entries losing items without an id), restore-checked at the delete's queue time
  // (upsert_queued_history, review round 9): a plain upsert sent after the row delete overwrote a restore that landed in
  // between. Each stays queued with that time until the server answers; a voided one is dropped (the restore's copy wins).
  const sendHistoryRewrites = useCallback(async (entries, queuedAt) => {
    for (const l of entries) {
      savedLogIds.current.add(l.id); addHistoryEntry(l);
      if (!replaceQueuedUpload("history", l.id, l)) addFailedSync({ kind: "history", id: l.id, data: l, queuedAt });
    }
    const r = await sendQueuedHistory(entries, queuedAt);
    for (const id of r.voided) removeFailedSync("history", id);
    for (const l of entries) if (r.upserted.includes(l.id)) removeFailedSync("history", l.id, e => sameLogContent(e.data, l));
    setFailedSyncCount(getFailedSyncs().length);
    return r;
  }, []);

  // Generations deleted on another device: their items leave this device's History entries too ("delete means delete").
  // The deleting device removes whole entries, which reach here by tombstone (batchLog.js purgeLogsForDeleted).
  const dropLogItemsFor = useCallback((removed) => {
    const gone = new Set(removed.map(t => t.id));
    const kept = tasksRef.current.filter(t => !gone.has(t.id));
    const { remove, rewrite } = purgeLogsForDeleted(logsRef.current, removed, kept, { removeEntries: false });
    const changed = rewrite.filter(l => !deletingLogIds.current.has(l.id));
    // An entry left with no items goes (review wf_ec400a67-988 #8): queued first, then removed here and in the cloud.
    const emptied = remove.filter(id => !deletingLogIds.current.has(id));
    if (!changed.length && !emptied.length) return;
    if (emptied.length) {
      for (const id of emptied) { deletingLogIds.current.add(id); savedLogIds.current.delete(id); removeFailedSync("history", id); }
      const emptiedAt = queueDeleteIntents("history-delete", emptied);
      deleteHistoryEntries(emptied);
      // Restore-checked at its queue time (review round 8). In flight for every tab until answered (task B9).
      const flight = beginDeleteFlight({ "history-delete": emptied }, emptiedAt);
      deleteHistoryRemote(emptied, emptiedAt).then(r => {
        if (r.deleted.length) confirmIntents("history-delete", r.deleted, emptiedAt);
        if (r.voided.length) {
          voidDeleteIntents("history-delete", r.voided, emptiedAt);
          releaseVoided(deletingLogIds, "history-delete", r.voided);
          giveBackVoided(emptiedAt);   // round 18 #3: stashes whose ids moved to this delete
        }
        setFailedSyncCount(getFailedSyncs().length);
      }).finally(() => endDeleteFlight(flight));
    }
    const dropped = new Set(emptied), byId = new Map(changed.map(l => [l.id, l]));
    logsRef.current = logsRef.current.filter(l => !dropped.has(l.id)).map(l => byId.get(l.id) || l);
    setLogs(prev => prev.filter(l => !dropped.has(l.id)).map(l => byId.get(l.id) || l));
    for (const l of changed) persistLog(l);
    setFailedSyncCount(getFailedSyncs().length);
  }, [persistLog]);

  // Save NEW logs to IndexedDB (and sync to Supabase): every entry not saved yet, not only the newest (two batches
  // logged in one render used to leave the second unsaved).
  useEffect(() => {
    for (const l of logs) {
      if (l?.id && !savedLogIds.current.has(l.id) && !deletingLogIds.current.has(l.id)) persistLog(l);
    }
  }, [logs, persistLog]);

  // A batch's entry is written when it starts and finished here once all its tasks have finished, in this tab, after
  // a reload or with results another device saved (rules in batchLog.js). Not before this session's first cloud sync:
  // a load more than 48 h after the batch expires the local copies first, and finishing from those would overwrite
  // the entry another device already finished correctly (round-3 review wf_393b4699-2d7 #2).
  useEffect(() => {
    if ((!historySyncReady || restorePendingRef.current) && isSupabaseConfigured()) return;
    const done = finishLogs(logs, tasks, Date.now()).filter(l => !deletingLogIds.current.has(l.id));
    if (!done.length) return;
    const byId = new Map(done.map(l => [l.id, l]));
    setLogs(prev => prev.map(l => byId.get(l.id) || l));
    for (const l of done) persistLog(l);
  }, [tasks, logs, persistLog, historySyncReady, restoreSettled]);

  // Track active count
  useEffect(() => {
    const active = tasks.filter(t => t.status === "pending" || t.status === "processing").length;
    setActiveCount(active);
  }, [tasks]);

  // Persist completed/failed tasks to IndexedDB + batch sync to Supabase
  useEffect(() => {
    // During cloud bootstrap, persist + queue but don't upload yet (avoids racing the pull); the
    // bootstrap replay uploads the queued rows. Skipping entirely used to lose results that finished
    // mid-bootstrap (never saved, never queued).
    const deferUpload = bootstrapInProgress.current;
    const unsaved = tasks.filter(t =>
      (t.status === "completed" || t.status === "failed") &&
      (!savedTaskIds.current.has(t.id) || recoveringIds.current.has(t.id)) &&
      !deletingIds.current.has(t.id) // never re-upsert a task being deleted
    );
    if (unsaved.length === 0) return;
    // Task B7a: nor one another tab is deleting or deleted (the shared delete state): a stale copy is neither stored
    // back here nor queued (the reconcile removes it once its delete is confirmed).
    const toSave = uploadable("task", unsaved);
    if (toSave.length === 0) return;
    for (const t of toSave) {
      savedTaskIds.current.add(t.id);
      recoveringIds.current.delete(t.id);
      saveTask(t); // Local IndexedDB always succeeds first — cloud sync is separate
      if (!deferUpload) taskSyncQueueRef.current.push(t);
      // Also record in failed-queue preemptively so if the tab closes mid-debounce,
      // the next session will replay it. Removed on successful cloud sync below.
      addFailedSync({ kind: "task", id: t.id, data: t });
    }
    setFailedSyncCount(getFailedSyncs().length);
    if (deferUpload) return;
    // Debounced batch upload to Supabase (flushes 300ms after last task)
    if (taskSyncTimerRef.current) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = setTimeout(() => {
      // Drop any ids the user deleted between queueing and this flush.
      const queue = taskSyncQueueRef.current.splice(0).filter(t => !deletingIds.current.has(t.id));
      taskSyncTimerRef.current = null;
      if (queue.length === 0) return;
      trackedSync(`tasks-batch-${Date.now()}`, () => sendTasks(queue))
        .then((sent) => {
          // Successful sync — clear the preemptive failure entries
          for (const t of sent) removeFailedSync("task", t.id, sentVersion(t));
          setFailedSyncCount(getFailedSyncs().length);
        })
        .catch(() => {
          // Sync failed: entries already in failed-queue, nothing else to do.
          // Next mount will replay them automatically.
          setFailedSyncCount(getFailedSyncs().length);
        });
    }, 300);
  }, [tasks]);

  // Flush pending writes aggressively on page-hide / before-unload.
  // This is the main defense against the race: tab-close mid-debounce used to drop
  // the queued writes silently. Now we either (a) flush them immediately, or
  // (b) warn the user and rely on the failed-sync queue to replay on next mount.
  useEffect(() => {
    const flushPending = () => {
      if (leavingRef.current) return;   // review r8 #1: never under another account's session (the queue replays later)
      // 1. Fire any pending task batch immediately
      if (taskSyncTimerRef.current) {
        clearTimeout(taskSyncTimerRef.current);
        taskSyncTimerRef.current = null;
        const queue = taskSyncQueueRef.current.splice(0).filter(t => !deletingIds.current.has(t.id));
        if (queue.length > 0) {
          // Fire-and-forget: we're mid-unload, can't await. The writes are already
          // in addFailedSync() so if this doesn't complete, replay handles it.
          sendTasks(queue).then((sent) => {
            for (const t of sent) removeFailedSync("task", t.id, sentVersion(t));
          }).catch(() => {});
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPending();
    };
    const onBeforeUnload = (e) => {
      if (leavingRef.current) return;   // review r8 #6: leaving for another session is not "unsaved changes"
      flushPending();
      // If there are still unsaved writes in the failed queue, warn the user
      const failed = getFailedSyncs();
      if (failed.length > 0 || taskSyncQueueRef.current.length > 0) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", flushPending);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", flushPending);
    };
  }, []);

  // Cleanup polling timeouts on unmount
  useEffect(() => {
    return () => { Object.values(pollRefs.current).forEach(id => clearTimeout(id)); };
  }, []);

  // ─── POLLING: one loop for new, regenerated and resumed tasks ───
  // Polls until WaveSpeed completes, fails or purges the task ("gone"), the task passes the 48 h resume
  // window, or (images) 5 min pass without an answer. Rate limits, network drops and 5xx retry with
  // backoff; a dead session or a missing key stops the loop without failing the task, and the resume
  // effect restarts it after sign-in / once a key is saved.
  function startPolling(task, pollUrl, { genType, resumed = false, delay } = {}) {
    // No client-side deadline: the task ends on WaveSpeed's answer or the 48 h window; slow tasks just poll less often.
    const started = task.startTime || Date.now();
    const wait = () => nextPollDelay(genType, Date.now() - started);
    // This loop is live while pollRefs holds its own timer: cancel, sign-out or a newer loop for the same task
    // removes or replaces it, and the loop then stops even if a request was already in flight.
    let timer = null;
    const schedule = (ms) => { timer = setTimeout(poll, ms); pollRefs.current[task.id] = timer; };
    const live = () => pollRefs.current[task.id] === timer;
    const update = (fn) => setTasks(prev => prev.map(t => t.id === task.id ? settlePoll(t, fn) : t));
    const finish = (fn) => { if (live()) delete pollRefs.current[task.id]; update(fn); };
    const poll = async () => {
      if (!live()) return;
      if (Date.now() - (task.startTime || 0) > RESUME_WINDOW_MS) { finish(t => failTask(t, Date.now(), EXPIRED_ERROR)); return; }
      try {
        const result = await pollResult(pollUrl);
        if (isKiePollUrl(pollUrl)) setKieKeyStatus(s => (s === "invalid" ? "ok" : s));   // kie.ai took the key again
        if (!live()) return;
        const data = result?.data || result;
        const now = Date.now();
        if (applyPoll(task, data, now)) finish(t => applyPoll(t, data, now));
        else schedule(wait());
      } catch (e) {
        if (!live()) return;
        const action = pollErrorAction(e);
        if (action === "stop") {
          delete pollRefs.current[task.id];
          // No key, or WaveSpeed rejected it: saving a working key flips keyBlocked back, and the resume effect restarts this poll.
          const ks = keyStatusAfter(e);
          if (ks) setKeyStatus(ks);
          // kie.ai rejected its key: shown in Settings; a working key saved there restarts this poll (S3 verification #3).
          if (e?.kie && (e.code === 401 || e.code === 403)) setKieKeyStatus("invalid");
        }
        else if (action === "retry") schedule(wait() * 2 + Math.random() * 2000);
        else finish(t => ({ ...t, status: "failed", error: e.message || (resumed ? "Poll error (resumed)" : "Poll error"), endTime: Date.now() }));
      }
    };
    schedule(delay ?? wait());
  }

  // ─── LOST SUBMITS: find them in WaveSpeed's history (rules in taskResume.js) ───
  // A submit cut off by a refresh or by the phone leaving the app leaves a "pending" task without a prediction id,
  // though WaveSpeed may have accepted it. This looks such tasks up, adopts the prediction it finds and polls it, and
  // fails a task only when a lookup that answered shows nothing after the grace. Runs on load, on return to the app,
  // after a cut-off submit and every 20 s while one waits.
  // ─── RUNNING TASKS ACROSS DEVICES (rules in syncReconcile.js) ───
  // A task is uploaded the moment WaveSpeed accepts it, so another open device can finish it while this one is frozen
  // or closed. Queued first like every cloud write; a confirmed upload clears only its own running entry, never the
  // finished version that may have replaced it in the queue meanwhile (the server keeps a finished row finished).
  const syncInFlight = useCallback((t) => {
    addFailedSync({ kind: "task", id: t.id, data: t });
    sendTask(t)
      .then(() => removeFailedSync("task", t.id, e => isInFlight(e.data)))
      .catch(() => {})
      .finally(() => setFailedSyncCount(getFailedSyncs().length));
  }, []);
  // Starts a poll for every running task that has none: pulled from another device, or loaded before its loop began.
  const pollUntracked = useCallback(() => {
    for (const t of planRepoll(tasksRef.current, Date.now(), -Infinity).kick) {
      if (!pollRefs.current[t.id]) startPolling(t, t.pollUrl, { genType: t.genType, resumed: true, delay: 500 });
    }
  }, []);

  // A submit that answers after its task was cancelled or deleted: the prediction id stays on the task (if it still
  // exists) and is released, so a lost submit of the same model can never adopt it (review wf_d4a468a3-746 #1).
  function keepLateSubmitId(id, predictionId, modelId) {
    resolveClaimants([id]); // its outcome is known now: as a claimant it would take a sibling's prediction instead
    if (!predictionId) return;
    releasePredictions([predictionId]);
    // Being deleted = gone (tasksRef is refreshed only on render): its id is in deletingIds or a queued task-delete
    // intent names it. Task B8b (review round 21 #4): or its delete was already confirmed (the shared record, any tab):
    // the belt to the submit hold that keeps it in deletingIds until this decision.
    const deleting = deletingIds.current.has(id) || pendingDeleteIds("task-delete").has(id) || uploadBlockedIds("task").has(id);
    // Task B12b (review round 25 #6/#11/#14): a delete of this tab that has not reserved anything yet (bulk delete during
    // its safety backup: the id is only in deletingIds; no intent, no call, no confirm anywhere) may still abort. The
    // result is ATTACHED to the task (its fresh copy in tasksRef), so that delete's plan, which reads the fresh copies
    // after the backup, holds it with the task (sent once the delete is final, kept if it is voided), and an abort leaves
    // the kept task with the result it paid for. Held for "now" instead, it stayed held, unlinked, forever.
    // Task B13a (review round 26 #7): both linking paths below do what applyRelinks does: the task is saved, its upload
    // queued (addFailedSync first, CLAUDE.md) and it leaves savedTaskIds, so the prediction id reaches the cloud (other
    // devices, future backups) through the shared upload filter once the task is not being deleted. Saved only to
    // IndexedDB, the cloud row kept task_id null: a delete on another device, or a void that brings the row back, left
    // the result on WaveSpeed linked to nothing.
    const linkLate = (t) => {
      const next = { ...t, taskId: predictionId };
      tasksRef.current = tasksRef.current.map(x => (x.id === id && !x.taskId ? next : x));
      setTasks(prev => prev.map(x => (x.id === id && !x.taskId ? { ...x, taskId: predictionId } : x)));
      savedTaskIds.current.delete(id);
      saveTask(next);
      addFailedSync({ kind: "task", id, data: next });
      setFailedSyncCount(getFailedSyncs().length);
    };
    if (deleting && deletingIds.current.has(id) && deleteHoldAt(id) === undefined) {
      const t = tasksRef.current.find(x => x.id === id);
      if (t) {
        if (!t.taskId) linkLate(t);
        return;
      }
    }
    const cur = deleting ? undefined : tasksRef.current.find(t => t.id === id);
    // Deleted (or cleared) while its submit was on the wire: delete the prediction on WaveSpeed too. A task that was only
    // cancelled is still here and keeps its result there (cancel is not delete). Review wf_9d0e3664-ab7 #3.
    // Missing WITHOUT a delete (review round 14): a paid result is never deleted on mere absence (a stale tasksRef, a
    // task beyond the loaded ones). The prediction stays on WaveSpeed, released above so no sibling's lost submit adopts
    // it; the claimant handling is today's, and orphan recovery decides the rest.
    // Review round 24 #6: that WaveSpeed delete is HELD for the delete that removed the task (its pending intent, its call
    // in flight, or its superseded confirm: storage.js deleteHoldAt; this tab's call not queued yet: now), so it follows
    // that delete's outcome: sent once it is final, cancelled if a void gives the task back. A clear stash's copy of the
    // task takes the id, so that give-back returns the generation WITH its result.
    if (!cur) {
      if (deleting) {
        recordStashPrediction(id, predictionId);
        // A kie.ai generation: kie.ai has no delete (its copy expires there in 14 days); WaveSpeed is never asked.
        if (!isKieModelId(modelId)) deleteOnWaveSpeed([{ id, taskId: predictionId, status: "processing" }], { holdAt: serverNow(), relink: true });
      }
      return;
    }
    if (cur.taskId) return;
    linkLate(cur);
  }

  // Task B12b (review round 25 #6/#7/#11-#15): the ready relinks (storage.js) of generations this tab holds: a late result
  // or a deleted claimant's prediction whose hold was cancelled because the generation is kept is linked back to it (a
  // waiting lost submit instead gets it un-released, so its lookup adopts it with its poll URL), and an archive that
  // finished while its delete was undecided is re-applied (queued first, as reapplyArchives does). A generation being
  // deleted here again waits; one another tab holds is left to that tab; an entry no tab applies lapses after 7 days.
  // Runs after every release that may cancel (the reconcile pass, the WaveSpeed flush, an aborted delete).
  // Task B13a (review round 26 #6): `extra`: tasks a give-back has just put into state (setTasks; tasksRef catches up only
  // on the next render), so a relink the give-back's release made ready is applied to them at once (applyClearStashes and
  // the inline voided branches call this after their put-back). readyRelinks first sends the relinks of generations
  // whose delete is final (storage.js settleFinalRelinks), so none lapses.
  function applyRelinks(extra = []) {
    const ready = readyRelinks();
    if (!ready.size) return;
    const done = new Map(), link = new Map(), archive = new Map(), unrelease = [];
    const inRef = new Set(tasksRef.current.map(t => t.id));
    const pool = [...tasksRef.current, ...(extra || []).filter(t => t?.id && !inRef.has(t.id))];
    for (const t of pool) {
      const r = ready.get(t.id);
      if (!r || deletingIds.current.has(t.id)) continue;
      const parts = {};
      if (r.p) {
        if (!t.taskId) { if (t.status === "pending" || isInFlight(t)) unrelease.push(r.p); else link.set(t.id, r.p); }
        parts.p = true;
      }
      if (r.a) { if (!t.isArchived) archive.set(t.id, r.a); parts.a = true; }
      done.set(t.id, parts);
    }
    if (unrelease.length) unreleasePredictions(unrelease);
    if (link.size || archive.size) {
      const fix = (t) => {
        let x = t;
        if (link.has(t.id) && !x.taskId) x = { ...x, taskId: link.get(t.id) };
        if (archive.has(t.id) && !x.isArchived) x = { ...x, ...archive.get(t.id), isArchived: true, archiving: false };
        return x;
      };
      tasksRef.current = tasksRef.current.map(fix);
      setTasks(prev => prev.map(fix));
      for (const t of pool.map(fix)) {
        if (!link.has(t.id) && !archive.has(t.id)) continue;
        savedTaskIds.current.delete(t.id);   // the persist effect saves, queues and syncs it again
        saveTask(t);
        addFailedSync({ kind: "task", id: t.id, data: t });   // queued first (CLAUDE.md); task B13a: a linked id too
      }
      setFailedSyncCount(getFailedSyncs().length);
    }
    dropRelinks(done);
  }

  const submittingIds = useRef(new Set());
  const submitSeq = useRef(0);   // counts submits started: recoverOrphans decides nothing if one started during its awaits
  const orphanLookupRunning = useRef(false);
  const recoverOrphans = useCallback(async () => {
    // A submit still in flight could own the very prediction an orphan would match: wait until none is.
    if (orphanLookupRunning.current || submittingIds.current.size) return;
    const lostKie = new Set(lostKieSubmits(tasksRef.current, submittingIds.current, Date.now()).map(t => t.id));
    if (lostKie.size) setTasks(prev => prev.map(t => lostKie.has(t.id) ? settlePoll(t, t => failTask(t, Date.now(), KIE_LOST_ERROR)) : t));
    const orphans = tasksRef.current.filter(t => isOrphan(t, submittingIds.current, Date.now()));
    // Tasks cancelled or deleted before their submit gave an id pair with their own prediction too (never adopted). A
    // claimant alone needs the lookup as well (review #10), once this device's tasks are loaded (its task must be found).
    const claimants = storedClaimants();
    if (!claimantLookupNeeded(orphans, claimants) || (claimants.length && !initialLoadDone.current)) return;
    const seq = submitSeq.current;
    orphanLookupRunning.current = true;
    try {
      const windows = orphanWindows([...orphans, ...claimants]);
      // Each window is fetched on its own. Network trouble, a rate limit, a 5xx, a stopped session or a rejected key: ask
      // again on the next pass. A refusal of the lookup itself leaves the grace alone to decide for that window, as
      // before this lookup existed, and its claimants are not dropped; windows that answered keep their items (each
      // model's cluster sits inside one window, so they are complete). Round-5/6 reviews wf_5d9498dc-619, wf_c5014fa6-227.
      const items = [], answeredWindows = [];
      for (const w of windows) {
        try {
          items.push(...await listPredictions(w));
          answeredWindows.push(w);
        } catch (e) {
          const ks = keyStatusAfter(e);
          if (ks) setKeyStatus(ks);
          if (pollErrorAction(e) !== "fail") return;
        }
      }
      const answeredFor = (t) => answeredWindows.some(w => w.after <= t.startTime - LOOKUP_SKEW_MS && t.startTime + ORPHAN_GRACE_MS <= w.before);
      // Owned = predictions any task holds: here, on another device (its row may not have reached this one yet), or
      // released by a delete or a cancel. Without the cloud's answer nothing is decided this pass.
      // Rows started up to ORPHAN_GRACE_MS before a window or LOOKUP_SKEW_MS after it may own a prediction inside it.
      const cloudRows = [];
      for (const w of windows) {
        const rows = await pullTaskStartsInWindow(w.after - ORPHAN_GRACE_MS, w.before + LOOKUP_SKEW_MS);
        if (!rows) return;
        cloudRows.push(...rows);
      }
      const cloudOwned = cloudRows.map(r => r.taskId).filter(Boolean);
      // A submit that started during the awaits above may own a prediction listed here: decide nothing this pass.
      if (lookupStale(seq, submitSeq.current, submittingIds.current.size)) return;
      const owned = new Set([...tasksRef.current.map(t => t.taskId).filter(Boolean), ...releasedPredictions(), ...cloudOwned]);
      const { adopt, fail, claimed, resolved, claims } = planOrphans(orphans, items, owned, Date.now(), claimants, { answeredFor });
      // Deleted claimants: their prediction goes on WaveSpeed too, but only on an unambiguous match, a lone claimant or a
      // whole deleted batch whose count matches (taskResume.js unambiguousDeletes, review wf_ec400a67-988 #10 and round
      // 2); otherwise it is only released. Cancelled ones: the id is linked to the task, so a later delete on any device
      // reaches it (planClaimOutcomes).
      const { attach, del } = planClaimOutcomes(claims, tasksRef.current);
      const sure = new Set(unambiguousDeletes(claims, cloudRows));
      const delNow = del.filter(id => sure.has(id));
      // Review round 24 #6: each carries its claimant's generation id, so the delete is held for that generation's own
      // delete while it is pending, in flight or superseded (deleteOnWaveSpeed), and the flush can ask about it (tid).
      const claimantOf = new Map(claims.map(c => [c.predictionId, c.claimantId]));
      // Task B12b (review round 25 #7/#12/#15): held with a relink, so a claimant its delete's void or a restore keeps gets
      // this prediction back (applyRelinks: linked, or un-released for a waiting lost submit's lookup to adopt).
      const unstored = new Set(delNow.length ? deleteOnWaveSpeed(delNow.map(id => ({ id: claimantOf.get(id), taskId: id, status: "processing" })), { relink: true }) : []);
      // Task B12a (review round 25 #18): only once its delete is stored (held or queued) is a prediction released and its
      // claimant resolved; one that could not be stored (a full localStorage, said by deleteOnWaveSpeed) stays a claim, so
      // the next lookup pairs it again and retries.
      const retry = new Set(claims.filter(c => unstored.has(c.predictionId)).map(c => c.claimantId));
      releasePredictions(claimed.filter(p => !unstored.has(p)));
      resolveClaimants(resolved.filter(id => !retry.has(id)));
      if (attach.length) {
        const link = new Map(attach.map(a => [a.id, a.predictionId]));
        for (const id of link.keys()) savedTaskIds.current.delete(id);   // the persist effect saves, queues and syncs it again
        setTasks(prev => prev.map(t => link.has(t.id) && !t.taskId ? { ...t, taskId: link.get(t.id) } : t));
      }
      const decided = new Map([...adopt, ...fail].map(t => [t.id, t]));
      if (!decided.size) return;
      // Only a task still waiting takes the outcome (not one cancelled while the lookup ran).
      const waiting = (t) => t?.status === "pending" && !t.taskId;
      const adoptNow = adopt.filter(t => waiting(tasksRef.current.find(x => x.id === t.id)));
      setTasks(prev => prev.map(t => decided.has(t.id) && waiting(t) ? decided.get(t.id) : t));
      for (const t of adoptNow) {
        saveTask(t);
        syncInFlight(t);
        startPolling(t, t.pollUrl, { genType: t.genType, resumed: true, delay: 0 });
      }
    } finally {
      orphanLookupRunning.current = false;
    }
  }, []);
  useEffect(() => {
    if (!isAuthed || keyBlocked) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") recoverOrphans(); }, 20000);
    return () => clearInterval(id);
  }, [isAuthed, keyBlocked, recoverOrphans]);

  // ─── DELETES REACH WAVESPEED TOO (rules in wsDelete.js) ───
  // A generation deleted here (bulk delete, Clear Outputs, Reset Everything) is deleted on WaveSpeed as well. The ids
  // are queued first and the queue is sent by the delete itself, after each cloud sync pass and every minute while it
  // holds anything; each answer settles each id (deleted, skipped, still running, or a transient failure). Like the file
  // queue, it acts only once this session's rows are loaded and the cloud has answered, so a stale view never decides
  // (review wf_ec400a67-988 #5).
  const wsDeleteRunning = useRef(false);
  const flushWsDeletes = useCallback(async () => {
    if (wsDeleteRunning.current || !fileFlushReady({ loaded: initialLoadDone.current, synced: cloudSyncedRef.current })) return;
    wsDeleteRunning.current = true;
    try {
      releaseHeldPurges();   // review round 23 #3: the held WaveSpeed ids whose deletes are decided
      applyRelinks();   // task B12b: a kept generation gets back a late result whose hold that release cancelled
      // Belt (S3 review #4/#8/#13): no id of a kie.ai generation this device knows of (a task or a History item) is sent to
      // WaveSpeed, whatever path queued it; kie.ai has no delete, its copy expires in 14 days.
      const kieIds = [...tasksRef.current, ...logsRef.current.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : []))]
        .filter(isKieGeneration).map(t => t.taskId).filter(Boolean);
      if (kieIds.length) writeWsDeletes(dropDeletes(readWsDeletes(), kieIds));
      // Never send an id a live task holds; it waits and is checked again (wsDelete.js holdHeldIds).
      writeWsDeletes(holdHeldIds(readWsDeletes(), tasksRef.current.filter(t => !deletingIds.current.has(t.id)).map(t => t.taskId).filter(Boolean), Date.now()));
      // Guard (review round 23 #3): nor one a hold still covers or a stored clear stash holds (a void gives it back).
      writeWsDeletes(holdHeldIds(readWsDeletes(), [...heldDeleteRefs().predictions], Date.now()));
      // Nor one a cloud row of this account holds: a restore brought it back, or another device kept it, while this
      // view has not caught up (review round 4; files have the same check, paths_in_use). Unanswered: nothing is sent.
      // Nor one whose generation's delete is still pending or in a call of any tab (review round 24 #6/#7): that delete's
      // outcome decides it (an entry a previous build queued directly). Task B12a (review round 25 #2): it moves into that
      // delete's hold (no 48 h cap: sent once the delete is final, cancelled if the generation is kept); one the hold
      // cannot take waits here, re-checked, also with no cap (waitHeldIds), never dropped unsent.
      const deletingNow = new Set([...pendingDeleteIds("task-delete"), ...inFlightIds("task-delete")]);
      const queued = readWsDeletes();
      const ofDeleting = Object.keys(queued).filter(p => queued[p]?.tid && deletingNow.has(String(queued[p].tid)));
      if (ofDeleting.length) {
        const left = holdDeletingWsEntries(ofDeleting);
        if (left.length) writeWsDeletes(waitHeldIds(readWsDeletes(), left, Date.now()));
      }
      const due = dueDeletes(readWsDeletes(), Date.now()).flat();
      if (due.length) {
        const inUse = await predictionsInUseRemote(due);
        if (!inUse) return;
        // Every cloud-held prediction holds (review round 24 #7): the exemption for a row whose own delete was pending
        // ("going", rounds 5/6) is gone. Held purges reach this queue only once their delete is final (the row is gone),
        // so the exemption only let a pending delete's directly queued results be deleted before its outcome.
        const held = [...inUse].map(([prediction]) => prediction);
        // A generation live only in History (a restore brought it back without its tasks row) holds its copy too: the
        // entries keep the generation's id (review round 6). Unanswered: nothing is sent this pass.
        const queue = readWsDeletes();
        const tids = [...new Set(due.map(p => queue[p]?.tid).filter(Boolean))];
        const live = tids.length ? await generationsLiveRemote(tids) : new Set();
        if (!live) return;
        for (const p of due) if (queue[p]?.tid && live.has(queue[p].tid)) held.push(p);
        // Task B14 (review round 27 #7): nor one that rows not uploaded yet name, another browser's (its published
        // form-inputs:<browser>:unsent) or this browser's (its failed-sync queue): that generation may still land, e.g. a
        // History-only one a voided Reset or Clear Outputs planned from its item. Unreadable: nothing is sent this pass.
        const pubs = isSupabaseConfigured() ? await pullFormHolds() : [];
        if (pubs === null) return;
        const unsent = liveUnsent([...pubs, { at: serverNow(), ...unsentGenerations() }], serverNow());   // cloud clock (S3 verification #9)
        for (const p of due) if (unsent.predictions.has(p) || (queue[p]?.tid && unsent.ids.has(String(queue[p].tid)))) held.push(p);
        if (held.length) writeWsDeletes(holdHeldIds(readWsDeletes(), held, Date.now()));
      }
      // Task B13b (found by the simulator): only ids the checks above saw are sent. The send re-reads the queue, and an id
      // queued during those awaits (a delete's release, another tab, this tab's reconcile) was sent without any check: a
      // result the cloud still held (a Clear Outputs generation the server left in place) was deleted. It waits for the
      // next flush, which checks it.
      const checked = new Set(due);
      for (const chunk of dueDeletes(readWsDeletes(), Date.now())) {
        const ids = chunk.filter(p => checked.has(p));
        if (!ids.length) continue;
        try {
          const deleted = await deletePredictions(ids);
          writeWsDeletes(settleDeletes(readWsDeletes(), ids, deleted, Date.now()));
        } catch (e) {
          writeWsDeletes(failDeletes(readWsDeletes(), ids, e, Date.now()));
          const ks = keyStatusAfter(e);
          if (ks) setKeyStatus(ks);
          if (pollErrorAction(e) !== "fail") break; // network or key trouble: the rest waits for the next pass
        }
      }
    } finally {
      wsDeleteRunning.current = false;
    }
  }, []);
  // Review round 24 #6: every WaveSpeed delete of a generation (`removed`: { id: its generation, taskId: its prediction })
  // goes through the hold while that generation's delete is not final (storage.js deleteHoldAt); `holdAt`: the time to
  // hold for when nothing here records that delete yet (this tab's own call, intents not queued). Queued directly only
  // when it is final or unknown here.
  // Task B12a (review round 25 #18): both writes are checked, and a refused hold never falls back to the direct queue
  // (that sent a pending delete's result before its outcome). Returns the prediction ids neither held nor queued, and
  // says so (saveStatus error, a storage-full toast): never a silent success. The lost-submit lookup keeps those
  // claimants and predictions unresolved, so its next pass tries again.
  // Task B12b (review round 25 #6/#7/#12/#14/#15): `relink` (a late submit's result, a deleted claimant's prediction):
  // the held result also records a relink (storage.js holdLateResult), so if that generation is kept after all (its
  // delete aborted, was voided, or a restore brought it back) the cancelled hold hands the prediction back to it
  // (applyRelinks), instead of leaving it on WaveSpeed linked to nothing.
  // Task B13a (review round 26 #6): a pending or ready relink of that generation (another late result, an archive held
  // while an earlier delete was undecided) is part of it: held with it here too (storage.js relinksOf), so this delete's
  // outcome decides it; once that delete is final, readyRelinks sends what is left (settleFinalRelinks).
  // Task B13b: `flush: false` (the reconcile pass) only queues; the pass flushes once React has applied its removals.
  const deleteOnWaveSpeed = useCallback((removed, { holdAt, relink = false, flush = true } = {}) => {
    const now = Date.now(), direct = [], unstored = [];
    const relinks = relinksOf((removed || []).map(t => t?.id));
    for (const t of removed || []) {
      if (!t?.taskId) continue;
      const h = t?.id ? deleteHoldAt(t.id) : undefined;
      const at = h === undefined ? holdAt : h;
      if (at != null) {
        const ws = queueDeletes({}, [t], now);
        const ok = relink && t.id ? holdLateResult(at, t.id, t.taskId, ws[t.taskId]) : holdPurgeDeletes(at, { ws });
        if (!ok) unstored.push(t.taskId);
        const extra = relinkHold([t], relinks, now);
        if (ok && (Object.keys(extra.files).length || Object.keys(extra.ws).length)) holdPurgeDeletes(at, extra);   // not stored: readyRelinks decides it once final
        continue;
      }
      direct.push(t);
    }
    if (direct.length && !writeWsDeletes(queueDeletes(readWsDeletes(), direct, now))) unstored.push(...direct.map(t => t.taskId));
    if (unstored.length) {
      setSaveStatus("error");
      setAccountToast(WS_DELETE_FULL_TOAST);
      setTimeout(() => setAccountToast(""), 8000);
    }
    if (flush) flushWsDeletes();
    return unstored;
  }, [flushWsDeletes]);

  // ─── DELETE MEANS DELETE (owner, 2026-10-21: "literally everything as far as can be reached should be deleted and
  // unrecoverable") ───
  // Clear Logs / Clear Outputs / Reset Everything queue a delete intent for every removed id BEFORE the clear fires
  // (queueDeleteIntents), so a tab killed mid-clear replays them on load and the reconcile never brings those rows back
  // (review wf_ec400a67-988 #1). After the clear, the cloud is read again: the ids it no longer holds are settled, the
  // rest stay queued (replayed on Save and on load), and an unreadable cloud settles nothing (clearOutcome.js
  // clearSettlement). True only when the cloud is confirmed free of them. `at`: the clear's queue time; only its intents
  // (and older ones) are settled (task B7b, review round 20 #7): an id a later delete re-queued during the read keeps
  // that intent, and its own call or replay decides.
  const settleCloudClear = async ({ tasks, history, at }) => {
    const cloud = await pullCloudIds();
    let clean = true;
    for (const [kind, table, ids] of [["task-delete", "tasks", tasks], ["history-delete", "history", history]]) {
      if (!ids) continue;
      const { done, left } = clearSettlement(ids, cloud?.[table] ?? null);
      confirmIntents(kind, done, at);
      if (left.length) clean = false;
    }
    settleClearStashes();   // a clear whose intents are all confirmed needs no stash (round 14)
    setFailedSyncCount(getFailedSyncs().length);
    return clean;
  };

  // ─── FILES GO TOO, DURABLY (rules in fileDelete.js) ───
  const SUPA_BASE = import.meta.env.VITE_SUPABASE_URL || "";
  const fileDeleteRunning = useRef(false);
  const flushFileDeletes = useCallback(async () => {
    if (fileDeleteRunning.current || !fileFlushReady({ loaded: initialLoadDone.current, synced: cloudSyncedRef.current })) return;
    fileDeleteRunning.current = true;
    let removedAny = false;
    try {
      releaseHeldPurges();   // review round 23 #3: the held files whose deletes are decided
      const due = dueFileDeletes(readFileDeletes(), Date.now());
      if (!due.length) return;
      const owned = ownedPaths(tasksRef.current, logsRef.current, { taskIds: deletingIds.current, logIds: deletingLogIds.current });
      // Guard (review round 23 #3): a path a hold still covers, or a stored clear stash holds (a void gives it back), waits.
      for (const p of heldDeleteRefs().paths) owned.add(p);
      // Forms holding uploads: this tab, this browser's other tabs, and the other device (cloud; null = unreadable); and
      // the paths this browser's queued, not yet uploaded rows use (task B13c).
      const cloudHolds = isSupabaseConfigured() ? await pullFormHolds() : [];
      // Cloud holds were stamped on the server-aligned clock (S3 verification #9); this browser's own on its clock.
      const forms = new Set([...pathsInUse([draftFormRef.current]), ...liveFormPaths(readFormPublications(), Date.now()),
        ...liveFormPaths(cloudHolds || [], serverNow()), ...unsentUploadPaths()]);
      // Rows beyond this device's view (older than the 500 loaded, or on the other device) count too: one server question
      // per flush (review wf_ec400a67-988 #7). No answer: those paths wait.
      const candidates = due.filter(p => !owned.has(p) && !forms.has(p));
      const remote = candidates.length && isSupabaseConfigured() ? await pathsInUseRemote(candidates) : new Set();
      for (const p of due) {
        let outcome = classifyPath(p, { owned, forms, remote, formsKnown: cloudHolds !== null });
        if (!outcome) {
          if ((await deleteArchivedPath(p)) || (await deleteArchivedPath(p))) outcome = "deleted";
          else outcome = headOutcome(await headStatus(publicUrlOf(SUPA_BASE, p)));
        }
        writeFileDeletes(settleFileDelete(readFileDeletes(), p, outcome, Date.now()));
        if (outcome === "deleted" || outcome === "gone") removedAny = true;
      }
    } finally { fileDeleteRunning.current = false; }
    if (removedAny) getArchiveStats().then(st => setArchiveStats(st)).catch(() => {});
  }, []);

  // A generation delete reaches everything else: WaveSpeed's copy (wsDelete.js), its History entries or items
  // (batchLog.js purgeLogsForDeleted) and its uploaded and archived files no kept generation uses (purge.js). Backup
  // copies are scrubbed by the server in the delete's own transaction (migration 20261021175100). Two steps:
  // stagePurge queues every intent synchronously, before the caller's first network call (CLAUDE.md queue-first), and
  // returns the plan; purgeEverywhere(plan) runs it once the caller's row delete has answered, so a rewritten History
  // entry is uploaded after the deleted tasks are tombstoned (review wf_1945b758-923 #5).
  // `history: false` + `alsoLogs`: the caller clears History itself (Reset Everything) and passes the entries it removed.
  // `logs`: plan over these entries instead of this device's (Clear Outputs passes local + cloud, review round 2); only
  // the local ones change here, the cloud-only ones are just deleted.
  // `serverHistory` (a task delete through delete_queued_rows): the server strips the deleted items that carry an id in the
  // delete's own transaction, so only entries holding items without an id are sent from here (review round 8). This
  // device's own History is updated in full either way. The returned rewrite/remove are what is sent; localRemove is
  // every entry this device removed.
  // `at`: the History delete intents' queue time (Clear Outputs passes its snapshot time, taken before its purge read,
  // review round 10); default now.
  // `holdAt` (review round 23 #3): the queue time of the delete this purge belongs to (its task-delete intents). The
  // WaveSpeed ids and files are queued HELD for it (storage.js holdPurgeDeletes): they reach their queues only once that
  // delete is confirmed for each owner, a void cancels them (the given-back generation keeps its files and its WaveSpeed
  // result), and no answer keeps them held for the replay to decide.
  // Task B12a (review round 25 #1/#9/#16/#17): two steps. planStagePurge computes everything (purge.js planDeleteStage)
  // and changes nothing; the caller then writes its reservation (storage.js reserveDelete: its own intents, the History
  // intents planned here and the hold) as its FIRST state change, and stops with nothing changed when it cannot (a full
  // localStorage: storage-full message, nothing to undo). Only then does stagePurge(staged) apply the History changes.
  // Task B13a (review round 26 #6): with the removed generations' pending or ready relinks (held with them).
  const planStagePurge = useCallback((removed, kept, opts = {}) => planDeleteStage(opts.logs || logsRef.current, removed, kept,
    { ...opts, relinks: relinksOf((removed || []).map(t => t?.id)) }), []);
  const stagePurge = useCallback((staged) => {
    const { plan, send, doHistory, historyQueuedAt, history, removed } = staged;
    if (doHistory) {
      const gone = new Set(plan.remove), byId = new Map(plan.rewrite.map(l => [l.id, l]));
      logsRef.current = logsRef.current.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l);
      setLogs(prev => prev.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l));
      // The History delete intents (send.remove, at historyQueuedAt) were written by the caller's reservation.
      // Every entry dropped here leaves IndexedDB now, sent or not (review round 9): kept there, it came back on reload,
      // and one that never reached the cloud was uploaded again.
      deleteHistoryEntries(plan.remove).catch(() => {});
      const sent = new Set(send.rewrite.map(l => l.id));
      for (const l of plan.rewrite) {
        savedLogIds.current.add(l.id); addHistoryEntry(l);
        // Sent from here: queued with the action's queue time, so its replay is restore-checked too. Left to the server:
        // a queued upload of the entry is trimmed in place, or its replay would bring the deleted items back (round 9).
        if (sent.has(l.id)) addFailedSync({ kind: "history", id: l.id, data: l, queuedAt: historyQueuedAt });
        else replaceQueuedUpload("history", l.id, l);
      }
      // Task B12b (simulator F3): these trimmed copies are re-taken from the cloud once this delete settles (a void leaves
      // the cloud's entries whole; a confirm's are stripped the same way), whatever tab handles its answer or the restore.
      if (plan.rewrite.length) markHistoryResync([staged.holdAt, historyQueuedAt], plan.rewrite.map(l => l.id));
      for (const id of plan.remove) {
        deletingLogIds.current.add(id); savedLogIds.current.delete(id); removeFailedSync("history", id);
      }
    }
    setFailedSyncCount(getFailedSyncs().length);
    return { ...plan, rewrite: send.rewrite, remove: send.remove, localRemove: plan.remove, history, historyQueuedAt,
      predictionIds: removed.map(t => t.taskId).filter(Boolean) };
  }, []);
  const purgeEverywhere = useCallback(async (plan) => {
    if (!plan) return { note: "" };
    await flushWsDeletes();
    if (plan.history) {
      // The current version (finishLogs may have closed it meanwhile), restore-checked at the action's queue time (review
      // round 9); queued already. Awaited, so the toast below knows whether each rewrite landed. This device's IndexedDB
      // lost the removed entries in stagePurge.
      const rewrites = plan.rewrite.length
        ? sendHistoryRewrites(plan.rewrite.map(l => logsRef.current.find(x => x.id === l.id) || l), plan.historyQueuedAt)
        : null;
      if (plan.remove.length) {
        // Restore-checked at the action's queue time (review round 8): entries a later restore brought back stay. In
        // flight for every tab until answered (task B9).
        const flight = beginDeleteFlight({ "history-delete": plan.remove }, plan.historyQueuedAt);
        try {
          const hr = await deleteHistoryRemote(plan.remove, plan.historyQueuedAt ?? undefined);
          if (hr.deleted.length) confirmIntents("history-delete", hr.deleted, plan.historyQueuedAt);
          if (hr.voided.length) {
            voidDeleteIntents("history-delete", hr.voided, plan.historyQueuedAt);
            releaseVoided(deletingLogIds, "history-delete", hr.voided);
            giveBackVoided(plan.historyQueuedAt);   // round 18 #3
          }
        } finally { endDeleteFlight(flight); }
      }
      await rewrites;
    }
    await flushFileDeletes();
    setFailedSyncCount(getFailedSyncs().length);
    return { note: purgeLeftNote(plan) };
  }, [flushWsDeletes, sendHistoryRewrites, flushFileDeletes]);
  // What is not finished yet goes in the toast (review wf_ec400a67-988 #4 and round 2): files, WaveSpeed copies,
  // History removals and rewrites. Review round 23 #3: files and WaveSpeed copies still held for their delete's
  // confirmation count as not deleted yet.
  const purgeLeftNote = (plan) => {
    const q = readFileDeletes(), ws = readWsDeletes(), left = heldPurgeLeft(plan.paths, plan.predictionIds);
    return purgeNote({
      files: pendingOf(q, plan.paths) + left.files, held: heldOf(q, plan.paths),
      ws: (plan.predictionIds || []).filter(id => ws[id]).length + left.ws,
      history: historyLeft(plan, getFailedSyncs()),
    });
  };
  // Clear Outputs / Reset confirm their generations only after the purge (settleCloudClear reads the cloud): the
  // files and WaveSpeed copies that confirm released go now, and the toast says what is left.
  const finishPurge = async (plan) => {
    await flushWsDeletes();
    await flushFileDeletes();
    return purgeLeftNote(plan);
  };
  // Both delete queues also run every minute while visible. Return to the app and reconnecting run a cloud sync pass
  // first, which flushes them once it has merged (reconcileWithCloud), never on the stale view (review #5). The file
  // queue is not gated on the WaveSpeed key: Storage deletes do not need it.
  useEffect(() => {
    if (!isAuthed || keyBlocked) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") flushWsDeletes(); }, 60000);
    return () => clearInterval(id);
  }, [isAuthed, keyBlocked, flushWsDeletes]);
  useEffect(() => {
    if (!isAuthed || !historySyncReady) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") flushFileDeletes(); }, 60000);
    return () => clearInterval(id);
  }, [isAuthed, historySyncReady, flushFileDeletes]);

  // ─── RESUME POLLING for in-flight tasks after refresh/close/OS-kill ───
  // On mount (after auth), load any pending/processing tasks from IndexedDB
  // with their saved pollUrl, inject them into state, and restart their polls.
  // Without this, hitting refresh or being backgrounded kills the poll timer
  // and the task stays "processing" forever.
  useEffect(() => {
    if (!isAuthed || keyBlocked) return;
    let cancelled = false;
    (async () => {
      const pending = await getPendingTasks();
      if (cancelled || !pending?.length) return;
      // Merge into state (de-duped by id)
      for (const t of pending) if (t.recovered) recoveringIds.current.add(t.id);
      setTasks(prev => {
        const byId = new Map(pending.map(t => [t.id, t]));
        // A recovered task replaces its failed copy in state, so the poll's result can land on it.
        const kept = prev.map(t => (t.status === "failed" && byId.get(t.id)?.recovered) ? byId.get(t.id) : t);
        const ids = new Set(prev.map(t => t.id));
        const fresh = pending.filter(t => !ids.has(t.id));
        return [...fresh, ...kept].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      });
      // Restart polling for each
      for (const task of pending) {
        if (!task.pollUrl || pollRefs.current[task.id]) continue;
        // Start polling almost immediately (the task has been waiting)
        startPolling(task, task.pollUrl, { genType: task.genType, resumed: true, delay: 500 });
      }
      // Lost submits (no prediction id) loaded as pending: look them up once state holds them.
      if (pending.some(t => !t.pollUrl)) setTimeout(recoverOrphans, 1000);
    })();
    return () => { cancelled = true; };
  }, [isAuthed, keyBlocked, keyStatus, hasKieKey]);   // a key saved or fixed restarts the polls it stopped (S3 review #11)

  // Coming back to the app re-polls every running task at once (rules in planRepoll): a phone that left it froze
  // the poll timers and cut the request in flight, so the result used to show only after a full interval or backoff.
  const repollAtRef = useRef(0);
  useEffect(() => {
    if (!isAuthed || keyBlocked) return;
    const kick = () => {
      if (document.visibilityState !== "visible") return;
      const { kick: due, at } = planRepoll(tasksRef.current, Date.now(), repollAtRef.current);
      repollAtRef.current = at;
      for (const t of due) {
        clearTimeout(pollRefs.current[t.id]); // the new loop replaces the old one; a request it has in flight is ignored
        startPolling(t, t.pollUrl, { genType: t.genType, resumed: true, delay: 0 });
      }
      recoverOrphans();
    };
    const onPageShow = (e) => { if (e.persisted) kick(); };
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", kick);
    return () => {
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", kick);
    };
  }, [isAuthed, keyBlocked, hasKieKey, recoverOrphans]);

  // Back in the app: re-check the key, at most once a minute. It may have been saved or rotated on another device;
  // a phone whose key was rejected would otherwise stay blocked (and its stopped polls stopped) until a reload.
  useEffect(() => {
    if (!isAuthed) return;
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60000) return;
      last = Date.now();
      refreshBalance().catch(() => {});
      refreshProviderKeys();   // a key saved or removed on another device changes the model list here too
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isAuthed, refreshBalance, refreshProviderKeys]);
  // Signed out: forget the last account's providers. Signed in (maybe as another account): that account's own cache.
  useEffect(() => {
    if (!isAuthed) { setProviderKeys(null); setProviderKeyList([]); setKieKeyStatus("unknown"); return; }
    const a = accountOf(), c = a ? cachedProviderKeys(a) : null;
    setProviderKeys(c ? new Set(c) : null);
  }, [isAuthed]);

  // Clean up pollUrl from IndexedDB once a task reaches terminal state.
  // Reuses the saveTask call that already runs in the persistence effect —
  // at that point status is completed/failed so pollUrl is simply overwritten.
  // Nothing extra to do; the field just becomes harmless metadata.

  // ─── BACK-BUTTON TRAP (PWA / mobile browsers) ───
  // Without this, Android back gesture or browser back button exits the PWA,
  // killing in-flight polls. Trap popstate, require a second press within 2s
  // to actually exit.
  useEffect(() => {
    if (!isAuthed) return;
    // Seed two history entries so we have something to catch
    try { window.history.pushState({ proximaTrap: 1 }, ""); } catch {}
    let lastBackAt = 0;
    let toastTimer = null;

    const onPopState = () => {
      const now = Date.now();
      if (now - lastBackAt < 2000) {
        // Second press within 2s — actually allow exit
        window.removeEventListener("popstate", onPopState);
        window.history.back();
        return;
      }
      // First press — show toast, push state back
      lastBackAt = now;
      setAccountToast("Press back again to exit");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setAccountToast(""), 2000);
      try { window.history.pushState({ proximaTrap: 1 }, ""); } catch {}
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, [isAuthed]);

  const models = useMemo(() => visibleModels(genType, providerKeys), [genType, providerKeys]);   // stable for unitQuotes' memo
  const categoryFavoriteIds = getCategoryFavoriteIds(favoriteModelsByType, genType);
  const favoriteModelCount = Object.keys(MODELS).reduce(
    (total, type) => total + getCategoryFavoriteIds(favoriteModelsByType, type).length,
    0,
  );
  const categoryFavoriteSet = new Set(categoryFavoriteIds);
  const selectedFavoriteSet = new Set(selectedModels);
  const categoryFavoritesSelected = categoryFavoriteIds.length > 0
    && selectedModels.length === categoryFavoriteIds.length
    && categoryFavoriteIds.every(id => selectedFavoriteSet.has(id));
  const selectedModelConfigs = selectedModels.map(id => models.find(m => m.id === id)).filter(Boolean);
  const effectiveImageBatchCount = getEffectiveImageBatchCount(selectedModelConfigs, numImages, genType);

  // The cockpit's current settings. Estimate, picker labels and handleGenerate all price tasks drafted from it
  // (src/lib/taskDraft.js), so a label, the estimate and the task price are the price of the same payload.
  // perModelRes: with per-model resolution dropdowns on screen, each model's shown value (taskDraft.js effectivePerModelRes).
  // Memoized so the quotes' memo below holds while the schemes differ (S3 verification #6/#8).
  const effectivePerModel = useMemo(() => effectivePerModelRes(selectedModelConfigs, perModelRes), [selectedModels, models, perModelRes]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftForm = { genType, prompt, negPrompt, resolution, duration, seed, aspectRatio, sourceImageUrl, sourceImageUrls,
    perModelRes: effectivePerModel, optionalParams, briaPresets, endFrameUrl, refVideoUrl,
    sourceAudioUrl, sourceVideoUrl };
  draftFormRef.current = draftForm;
  // This tab's Generate form inputs, published for every tab's file flush (fileDelete.js liveFormPaths, review #3):
  // refreshed every minute, withdrawn when the tab closes. This browser's live holds (all its tabs) also go to the cloud
  // for the other device's flush, when they change and every 10 minutes (review wf_ec400a67-988 #6). Task B13c (simulator
  // class B): with the paths this browser's queued, not yet uploaded rows use (storage.js unsentUploadPaths), so a batch
  // input a sibling still waiting to upload here needs is kept by the other device after this form let go of it.
  useEffect(() => {
    const publish = () => {
      publishFormPaths([...pathsInUse([draftFormRef.current])]);
      if (!isAuthedRef.current) return;   // review r7 #8: no cloud write before the account is confirmed (or when signed out)
      const local = Date.now(), now = formStamp(serverNow()), mine = [...liveFormPaths(readFormPublications(), local)];
      if (isSupabaseConfigured() && formPublishDue(cloudFormPubRef.current, mine, now)) {
        sendFormRow(mine, localFormPaths).then((sent) => { cloudFormPubRef.current = sent; }).catch(() => {});
      }
      // Task B14 (review round 27 #5/#7): this browser's rows not uploaded yet, in their own row (task B15: one module-level
      // publishUnsent, shared with the History senders, which publish first when an entry needs it).
      publishUnsent();
    };
    publish();
    const id = setInterval(publish, 60000);
    // Closing withdraws this tab's key and, when that changes this browser's set, sends the cloud publication at once
    // with keepalive (review round 3): the other device lets go of those files now, not FORM_HOLD_ALIVE_MS later.
    const bye = (e) => {
      if (e.persisted) return;
      forgetFormPaths();
      if (!isAuthedRef.current) return;
      const local = Date.now(), now = formStamp(serverNow()), mine = [...liveFormPaths(readFormPublications(), local)];
      if (isSupabaseConfigured() && cloudFormPubRef.current && !sameFormSet(cloudFormPubRef.current.paths, mine)) {
        setPageExiting(true);
        sendFormRow(mine, localFormPaths).catch(() => {});
      }
      publishUnsent({ exiting: true });   // task B15 (review round 28 #2): rows queued since the last tick, with keepalive
    };
    // Task B15 (review round 28 #2): Android freezes a hidden tab; its rows not uploaded yet are published as it hides.
    const hidden = () => { if (document.visibilityState === "hidden" && isAuthedRef.current) publishUnsent(); };
    window.addEventListener("pagehide", bye);
    document.addEventListener("visibilitychange", hidden);
    return () => { clearInterval(id); window.removeEventListener("pagehide", bye); document.removeEventListener("visibilitychange", hidden); };
  }, [sourceImageUrl, sourceImageUrls, endFrameUrl, refVideoUrl, sourceAudioUrl, sourceVideoUrl]);
  const mediaDuration = url => mediaDurations[url];
  const estQuotes = planImageBatchRequests(selectedModelConfigs, numImages, genType).map(plan => draftTask(plan, draftForm, { mediaDuration }).quote);
  const estCost = estQuotes.reduce((sum, q) => sum + q.cost, 0);
  const estExact = estQuotes.every(q => q.exact);
  // Picker labels: one generation of each model at the current settings. Recomputed only when a setting changes.
  const unitQuotes = useMemo(
    // Each label is the price of what selecting that model sends: adding it may split the schemes (S3 verification #7).
    () => new Map(models.map(m => [m.id, unitQuote(m, { ...draftForm, perModelRes: labelPerModelRes(selectedModelConfigs, m, perModelRes) }, { mediaDuration })])),
    [models, mediaDurations, selectedModels, ...Object.values(draftForm)], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function toggleModel(id) {
    setSelectedModels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function persistModelFavorites(nextByType) {
    const scope = getDeviceId();
    const updatedAt = Math.max(Date.now(), favoriteModelsUpdatedAtRef.current + 1);
    const snapshot = createModelFavoritesSetting(nextByType, updatedAt);
    favoriteModelsRef.current = snapshot.byType;
    favoriteModelsUpdatedAtRef.current = updatedAt;
    setFavoriteModelsByType(snapshot.byType);
    setSetting(localModelFavoritesKey(scope), snapshot);

    // Queue before the cloud call so a refresh, lost connection, or tab close can
    // never silently lose the user's latest favorite selection.
    addFailedSync({ kind: "model-favorites", id: scope, scope, data: snapshot });
    setFailedSyncCount(getFailedSyncs().length);

    favoriteSyncChainRef.current = favoriteSyncChainRef.current
      .catch(() => {})
      .then(() => trackedSync(`model-favorites:${updatedAt}`, async () => {
        await syncSetting(MODEL_FAVORITES_SETTING, snapshot, scope);
        const pending = getFailedSyncs().find(f => f.kind === "model-favorites" && f.scope === scope);
        if (pending?.data?.updatedAt === updatedAt) removeFailedSync("model-favorites", scope);
        setFailedSyncCount(getFailedSyncs().length);
        if (pending && pending.data?.updatedAt !== updatedAt) {
          throw new Error("A newer favorites update is still waiting to sync");
        }
      }))
      .catch(() => { setFailedSyncCount(getFailedSyncs().length); });
  }

  function toggleFavoriteModel(type, modelId) {
    persistModelFavorites(toggleFavoriteInMap(favoriteModelsRef.current, type, modelId));
  }

  // ─── FILE UPLOAD ───
  async function uploadSingleFile(file) {
    // Images are shrunk first (models fetch the URL; huge sources only slow them down). Files go to our
    // public storage bucket, so no WaveSpeed key is needed in the browser.
    const toSend = await downscaleImage(file, { maxEdge: 2048, maxBytes: 1_500_000 });
    return uploadMedia(toSend);
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []).slice(0, maxImagesAllowed);
    if (files.length === 0) return;

    // Preview first image
    const reader = new FileReader();
    reader.onload = (ev) => setSourcePreview(ev.target.result);
    reader.readAsDataURL(files[0]);

    setUploadStatus("uploading");

    // allSettled so one bad file doesn't sink the whole batch.
    const results = await Promise.allSettled(files.map(f => uploadSingleFile(f)));
    const urls = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
    results.filter(r => r.status === "rejected")
      .forEach(r => console.warn("[upload]", r.reason?.message || r.reason));

    if (urls.length === 0) {
      setUploadStatus("error");
    } else {
      const limitedUrls = urls.slice(0, maxImagesAllowed);
      setSourceImageUrl(limitedUrls[0]);
      setSourceImageUrls(limitedUrls.slice(1));
      setUploadStatus("done");
    }
    // Reset input so same files can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Upload additional reference images from gallery picker
  async function handleAdditionalFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const results = await Promise.allSettled(files.map(f => uploadSingleFile(f)));
    const urls = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
    results.filter(r => r.status === "rejected")
      .forEach(r => console.warn("[upload+]", r.reason?.message || r.reason));
    if (urls.length > 0) {
      setSourceImageUrls(prev => [...prev, ...urls].slice(0, Math.max(0, maxImagesAllowed - 1)));
    }
    if (multiImageFileRef.current) multiImageFileRef.current.value = "";
  }

  // C2: end-frame image upload (last_image / end_image) — single image, reuses downscale+upload
  async function handleEndFrameSelect(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setEndFramePreview(ev.target.result);
    reader.readAsDataURL(file);
    setEndFrameStatus("uploading");
    try {
      const url = await uploadSingleFile(file);
      if (url) { setEndFrameUrl(url); setEndFrameStatus("done"); }
      else setEndFrameStatus("error");
    } catch (err) { console.warn("[endframe]", err?.message || err); setEndFrameStatus("error"); }
    if (endFrameInputRef.current) endFrameInputRef.current.value = "";
  }

  // C3: avatar audio / driving-video upload (URL paste also supported in the cards)
  async function handleAudioSelect(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    setSourceAudioStatus("uploading");
    try { const url = await uploadSingleFile(file); if (url) { setSourceAudioUrl(url); setSourceAudioStatus("done"); } else setSourceAudioStatus("error"); }
    catch (err) { console.warn("[avatar-audio]", err?.message || err); setSourceAudioStatus("error"); }
    if (audioInputRef.current) audioInputRef.current.value = "";
  }
  async function handleAvatarVideoSelect(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    setSourceVideoStatus("uploading");
    try { const url = await uploadSingleFile(file); if (url) { setSourceVideoUrl(url); setSourceVideoStatus("done"); } else setSourceVideoStatus("error"); }
    catch (err) { console.warn("[avatar-video]", err?.message || err); setSourceVideoStatus("error"); }
    if (videoInputRef.current) videoInputRef.current.value = "";
  }

  function clearSourceImage() {
    setSourceImageUrl("");
    setSourceImageUrls([]);
    setSourcePreview("");
    setUploadStatus("");
  }

  // Compute reference capacity across selected image-input models. Singular
  // endpoints still receive only the first image in buildPayload.
  const maxImagesAllowed = (() => {
    if (!['i2i', 'i2v', 'avatar'].includes(genType) || selectedModels.length === 0) return 1;
    const caps = selectedModels.map(id => {
      const m = models.find(x => x.id === id);
      return m?.params?.maxImages || 1;
    }).filter(v => v > 1);
    return caps.length > 0 ? Math.max(...caps) : 1;
  })();

  // ─── GENERATION ENGINE ───
  async function handleGenerate() {
    const selectedConfigs = selectedModels.map(id => models.find(m => m.id === id)).filter(Boolean);
    const promptRequired = selectedConfigs.some(m => !m.params?.noPrompt) && genType !== "avatar";
    // Only models the picker offers run (a removed key, a favorite or Edit may have selected a hidden one): none, no batch.
    if (keyBlocked || (promptRequired && !prompt.trim()) || selectedConfigs.length === 0) return;
    const sourceTypes = ["i2i", "i2v", "i23d", "v2v", "avatar"];
    const sourceRequired = sourceTypes.includes(genType) && selectedConfigs.some(m => !m.params?.sourceOptional);
    if (sourceRequired && !sourceImageUrl.trim()) {
      alert(`Please provide a source ${genType === "v2v" ? "video" : "image"}.`);
      return;
    }
    if (selectedConfigs.some(m => m.params?.requiresLastImage) && !endFrameUrl.trim() && sourceImageUrls.length === 0) {
      alert("Please add a second image for the end frame.");
      return;
    }
    if (selectedConfigs.some(m => m.params?.requiresSecondImage) && sourceImageUrls.length === 0) {
      alert("Please add the required second reference image.");
      return;
    }
    if (genType === "avatar") {
      const av = selectedModels.map(id => models.find(m => m.id === id)).filter(Boolean);
      if (av.some(m => m.requiresAudio) && !sourceAudioUrl.trim()) { alert("This avatar model needs a source audio file — upload or paste a URL in the Source Audio box."); return; }
      if (av.some(m => m.requiresVideo) && !sourceVideoUrl.trim()) { alert("This avatar model needs a driving video — upload or paste a URL in the Driving Video box."); return; }
    }
    isGeneratingRef.current = true;
    setIsGenerating(true);
    setPage("cockpit");

    const batchId = genId();
    const batchPlan = planImageBatchRequests(selectedConfigs, numImages, genType);
    const newTasks = batchPlan.map(plan => draftTask(plan, draftForm, { id: genId(), batchId, mediaDuration }).task);

    setTasks(prev => [...newTasks, ...prev]);
    // Stored before the submit fires: a refresh or a phone leaving the app mid-submit used to lose the task entirely.
    saveTasks(newTasks);
    // The History entry too; it is finished with every outcome once all its tasks have finished (batchLog.js).
    setLogs(prev => [{
      id: batchId, timestamp: Date.now(), prompt, negPrompt, genType,
      models: newTasks.map(t => t.modelName), resolution, duration, seed, aspectRatio,
      sourceImageUrl, sourceImageUrls: sourceImageUrls.length > 0 ? [...sourceImageUrls] : [],
      sourceAudioUrl, sourceVideoUrl, endFrameUrl, refVideoUrl, numImages,
      tasks: batchLogItems(newTasks), totalCost: 0,
    }, ...prev]);

    // Fire all in parallel
    for (const task of newTasks) {
      (async () => {
        let sent = false;
        // Task B8b (review round 21 #4): while its submit is on the wire, a task a Clear / Reset / delete removes stays
        // "being deleted" in this tab (pruneDeleting skips held ids), so keepLateSubmitId still deletes its late prediction
        // on WaveSpeed. Released once the submit settled (finally: after keepLateSubmitId's decision or the poll start).
        const submitHold = {};
        holdDeleting("task-delete", [task.id], submitHold);
        try {
          // Build per-model payload using model's params config
          const modelConfig = models.find(m => m.id === task.modelId);
          const payload = modelConfig?.params
            ? buildPayload(modelConfig, taskUserSettings(task, task.genType || genType), task.genType || genType)
            : { prompt: task.prompt, resolution: task.resolution };

          sent = true;
          submittingIds.current.add(task.id); submitSeq.current++;
          const submitRes = await submitTask(task.modelId, payload).finally(() => submittingIds.current.delete(task.id));
          const taskId = submitRes?.data?.id;
          const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;
          // Cancelled (or deleted) while the submit was on the wire: it stays that way.
          if (!isInFlight(tasksRef.current.find(t => t.id === task.id))) { keepLateSubmitId(task.id, taskId, task.modelId); return; }

          // Check if sync mode returned outputs directly
          if (submitRes?.data?.outputs?.length > 0) {
            const wallClock = Date.now() - task.startTime;
            setTasks(prev => prev.map(t => t.id === task.id ? settlePoll(t, t => ({
              ...t, status: "completed", outputs: submitRes.data.outputs,
              endTime: Date.now(), wallClockMs: wallClock,
              inferenceMs: submitRes.data?.timings?.inference || wallClock
            })) : t));
            return;
          }

          // Persist pollUrl immediately so we can resume polling after tab close / refresh / OS kill
          setTasks(prev => prev.map(t => t.id === task.id ? settlePoll(t, t => ({ ...t, status: "processing", taskId, pollUrl })) : t));
          saveTask({ ...task, status: "processing", taskId, pollUrl });
          syncInFlight({ ...task, status: "processing", taskId, pollUrl });

          startPolling(task, pollUrl, { genType: task.genType || genType });

        } catch (e) {
          // The response was lost, not refused: WaveSpeed may have the task. It stays pending for the history lookup.
          // kie.ai has no task history to look a lost submit up in: it fails now, saying it may have run (taskResume.js).
          if (sent && submitMayHaveLanded(e) && isKieModelId(task.modelId)) {
            setTasks(prev => prev.map(t => t.id === task.id ? settlePoll(t, t => failTask(t, Date.now(), KIE_LOST_ERROR)) : t));
            return;
          }
          if (sent && submitMayHaveLanded(e)) { setTimeout(recoverOrphans, 2000); return; }
          resolveClaimants([task.id]); // refused: it never reached WaveSpeed, so a cancel left nothing to claim
          const ks = keyStatusAfter(e);
          if (ks) setKeyStatus(ks);
          let errMsg = e.message || "Submit failed";
          if (e.code === 401 && !e.session) errMsg = e.kie ? "kie.ai rejected the saved key — update it in Settings" : "WaveSpeed rejected the saved API key — update it in Settings";
          if (e.code === 402) errMsg = "Insufficient balance";
          if (e.code === 429) errMsg = "Rate limited — try fewer models";
          setTasks(prev => prev.map(t => t.id === task.id ? {
            ...t, status: "failed", error: errMsg, endTime: Date.now()
          } : t));
        } finally {
          unholdDeleting("task-delete", [task.id], submitHold);
        }
      })();
    }

    // Update timers
    const timerId = setInterval(() => {
      setTasks(prev => {
        const anyActive = prev.some(t => t.batchId === batchId && (t.status === "pending" || t.status === "processing"));
        if (!anyActive) {
          clearInterval(timerId);
          // Check if ANY tasks across ALL batches are still active
          const anyGlobalActive = prev.some(t => t.status === "pending" || t.status === "processing");
          if (!anyGlobalActive) {
            isGeneratingRef.current = false;
            setIsGenerating(false);
          }
          // (The batch's History entry is finished by the effect over tasks, which also runs after a reload.)
          // Refresh balance
          refreshBalance().catch(() => {});
        }
        return prev.map(t => {
          if ((t.status === "pending" || t.status === "processing") && t.batchId === batchId) {
            return { ...t, wallClockMs: Date.now() - t.startTime };
          }
          return t;
        });
      });
    }, 500);
  }

  const cancelTask = useCallback((taskId) => {
    // A submit without a prediction id yet may still land: the task stays a claimant, so no other lost submit of the
    // same model adopts its result (taskResume.js planOrphans).
    recordClaimants([tasksRef.current.find(t => t.id === taskId)]);
    // Removing the timer also ends a loop whose request is in flight (startPolling checks it after the await).
    if (pollRefs.current[taskId]) clearTimeout(pollRefs.current[taskId]);
    delete pollRefs.current[taskId];
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: "failed", error: "Cancelled", endTime: Date.now() } : t));
  }, []);

  // Regenerate — re-submit the same task with a new ID, without disrupting existing results
  // Wrapped in useCallback so CockpitTaskCard memo equality holds. Deps: keyBlocked (used inside).
  const regenerateTask = useCallback(function regenerateTask(originalTask) {
    if (keyBlocked) return;
    const newTask = retryTask(originalTask, { id: genId(), now: Date.now(), seed: Math.floor(Math.random() * 999999).toString() });
    // Re-price from the payload this run sends (a task made before formula pricing carries a default-settings price).
    const regenType = newTask.genType || genType;
    const regenModel = (CATALOG[regenType] || []).find(m => m.id === newTask.modelId);
    if (regenModel?.params) {
      const labels = runLabels(regenModel, taskUserSettings(newTask, regenType));
      newTask.actualRes = labels.actualRes;
      newTask.actualDur = labels.actualDur;
      newTask.price = requestCost(regenModel, buildPayload(regenModel, taskUserSettings(newTask, regenType), regenType), { imagesPerRequest: newTask.numImages || 1, mediaDuration: url => mediaDurationsRef.current[url] });
    }
    setTasks(prev => [newTask, ...prev]);
    saveTask(newTask); // stored before the submit fires, like handleGenerate

    // Timer for live wallClock display on regenerated task
    const regenTimer = setInterval(() => {
      setTasks(prev => {
        const t = prev.find(x => x.id === newTask.id);
        if (!t || t.status === "completed" || t.status === "failed") { clearInterval(regenTimer); return prev; }
        return prev.map(x => x.id === newTask.id ? { ...x, wallClockMs: Date.now() - x.startTime } : x);
      });
    }, 500);

    // Fire the regenerated task — use task's own genType, not current UI tab
    (async () => {
      let sent = false;
      // Task B8b (review round 21 #4): held "being deleted" while the submit runs, as in handleGenerate.
      const submitHold = {};
      holdDeleting("task-delete", [newTask.id], submitHold);
      try {
        const taskGenType = newTask.genType || genType;
        const taskModels = CATALOG[taskGenType] || [];
        const modelConfig = taskModels.find(m => m.id === newTask.modelId);
        if (!modelConfig) throw new Error(`${newTask.modelName || newTask.modelId} is no longer available — pick another model`);
        const payload = modelConfig?.params
          ? buildPayload(modelConfig, taskUserSettings(newTask, taskGenType), taskGenType)
          : { prompt: newTask.prompt };

        sent = true;
        submittingIds.current.add(newTask.id); submitSeq.current++;
        const submitRes = await submitTask(newTask.modelId, payload).finally(() => submittingIds.current.delete(newTask.id));
        const taskId = submitRes?.data?.id;
        const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;
        if (!isInFlight(tasksRef.current.find(t => t.id === newTask.id))) { keepLateSubmitId(newTask.id, taskId, newTask.modelId); return; } // cancelled meanwhile

        if (submitRes?.data?.outputs?.length > 0) {
          const wallClock = Date.now() - newTask.startTime;
          setTasks(prev => prev.map(t => t.id === newTask.id ? settlePoll(t, t => ({
            ...t, status: "completed", outputs: submitRes.data.outputs,
            endTime: Date.now(), wallClockMs: wallClock,
            inferenceMs: submitRes.data?.timings?.inference || wallClock
          })) : t));
          return;
        }

        // Persist pollUrl so a reload / tab kill can resume this poll (it used to be kept in memory only)
        setTasks(prev => prev.map(t => t.id === newTask.id ? settlePoll(t, t => ({ ...t, status: "processing", taskId, pollUrl })) : t));
        saveTask({ ...newTask, status: "processing", taskId, pollUrl });
        syncInFlight({ ...newTask, status: "processing", taskId, pollUrl });
        startPolling(newTask, pollUrl, { genType: taskGenType });
      } catch (e) {
        if (sent && submitMayHaveLanded(e) && isKieModelId(newTask.modelId)) {
          setTasks(prev => prev.map(t => t.id === newTask.id ? settlePoll(t, t => failTask(t, Date.now(), KIE_LOST_ERROR)) : t));
          return;
        }
        if (sent && submitMayHaveLanded(e)) { setTimeout(recoverOrphans, 2000); return; }
        resolveClaimants([newTask.id]); // refused: it never reached WaveSpeed
        const ks = keyStatusAfter(e);
        if (ks) setKeyStatus(ks);
        let errMsg = e.message || "Regenerate failed";
        if (e.code === 401 && !e.session) errMsg = e.kie ? "kie.ai rejected the saved key — update it in Settings" : "WaveSpeed rejected the saved API key — update it in Settings";
        if (e.code === 402) errMsg = "Insufficient balance";
        setTasks(prev => prev.map(t => t.id === newTask.id ? {
          ...t, status: "failed", error: errMsg, endTime: Date.now()
        } : t));
      } finally {
        unholdDeleting("task-delete", [newTask.id], submitHold);
      }
    })();
  }, [keyBlocked]);

  function replayLog(log) {
    setPrompt(log.prompt);
    setNegPrompt(log.negPrompt || "");
    setGenType(log.genType);
    setResolution(log.resolution);
    setDuration(log.duration);
    setSeed(log.seed);
    setAspectRatio(log.aspectRatio || "auto");
    setSourceImageUrls(log.sourceImageUrls?.length > 0 ? [...log.sourceImageUrls] : []);
    if (log.sourceImageUrl) { setSourceImageUrl(log.sourceImageUrl); setSourcePreview(log.sourceImageUrl); setUploadStatus("done"); }
    setSourceAudioUrl(log.sourceAudioUrl || "");
    setSourceAudioStatus(log.sourceAudioUrl ? "done" : "");
    setSourceVideoUrl(log.sourceVideoUrl || "");
    setSourceVideoStatus(log.sourceVideoUrl ? "done" : "");
    setEndFrameUrl(log.endFrameUrl || "");
    setEndFramePreview(log.endFrameUrl || "");
    setEndFrameStatus(log.endFrameUrl ? "done" : "");
    setRefVideoUrl(log.refVideoUrl || "");
    if (log.numImages) setNumImages(log.numImages);
    // Try to reselect models
    const modelIds = (CATALOG[log.genType] || []).filter(m => log.models.includes(m.name)).map(m => m.id);
    setSelectedModels(modelIds);
    setPerModelRes({});
    setPage("cockpit");
  }

  // ─── Stable handlers for CockpitTaskCard (perf fix #1: React.memo) ───
  const onDownloadTask = useCallback(async (task) => {
    try {
      const url = task.outputs?.[0];
      if (!url) return;
      const resp = await fetch(url);
      const blob = await resp.blob();
      const tgt = task.genType || "image";
      const ext = (tgt === "t2v" || tgt === "i2v" || tgt === "avatar" || blob.type.startsWith("video")) ? "mp4" : "png";
      const fname = `${task.modelName.replace(/\s+/g, "_")}_${Date.now()}.${ext}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 100);
    } catch (e) { console.log("Direct download blocked, opening in new tab"); window.open(task.outputs?.[0], "_blank"); }
  }, []);

  const onCloudArchiveTask = useCallback(async (task) => {
    if (task.isArchived) return;
    setTasks(prev => prev.map(x => x.id === task.id ? { ...x, archiving: true } : x));
    const newUrls = [];
    const paths = [];
    let anyOk = false;
    for (let i = 0; i < (task.outputs || []).length; i++) {
      const r = await archiveUrl(task.outputs[i], { taskId: task.id, index: i });
      if (r.ok) { newUrls.push(r.url); paths.push(r.path); anyOk = true; }
      else { newUrls.push(task.outputs[i]); }
    }
    // Deleted (or cleared) while its files were uploading (review round 14): saved now, the archived copy would bring the
    // task back, so nothing is saved. A clear that still holds the task (its stash, review round 15 S5) keeps the result:
    // a void re-applies it to the restored task (applyClearStashes / the voided branches), a confirm sends the files to
    // the file-delete queue. Otherwise they go through that queue now, as a purge's do (stagePurge).
    // Task B7a: deleted or being deleted in another tab counts too (the shared delete state).
    const here = tasksRef.current.some(t => t.id === task.id), blocked = uploadBlockedIds("task").has(task.id);
    if (deletingIds.current.has(task.id) || !here || blocked) {
      const patch = { outputs: newUrls, archivedOutputs: newUrls, archivedPaths: paths };
      const holdAt = deleteHoldAt(task.id);
      // Task B12b (review round 25 #13): this tab's delete has not reserved anything yet (bulk delete during its safety
      // backup: no intent, no call, no confirm) and the task is still here: the archive applies to it (its fresh copy), so
      // that delete's plan holds the archived files with the task, and an abort keeps the archive. Queued, not sent now:
      // the delete drops the queued upload once it reserves; an abort leaves it for the next save.
      if (here && !blocked && holdAt === undefined) {
        const cur = tasksRef.current.find(t => t.id === task.id);
        const updated = anyOk ? { ...cur, ...patch, isArchived: true, archiving: false } : { ...cur, archiving: false };
        tasksRef.current = tasksRef.current.map(t => (t.id === task.id ? updated : t));
        setTasks(prev => prev.map(x => (x.id === task.id ? { ...x, ...(anyOk ? { ...patch, isArchived: true } : {}), archiving: false } : x)));
        if (anyOk) { saveTask(updated); addFailedSync({ kind: "task", id: updated.id, data: updated }); setFailedSyncCount(getFailedSyncs().length); }
        getArchiveStats().then(s => setArchiveStats(s));
        return;
      }
      setTasks(prev => prev.map(x => (x.id === task.id && x.archiving ? { ...x, archiving: false } : x)));
      const held = recordStashArchive(task.id, { paths, task: anyOk ? { ...task, ...patch, isArchived: true, archiving: false } : null });
      if (!held && paths.length) {
        if (holdAt === null || holdAt === undefined) {
          // Its delete is final (or nothing here records one: as before): the generation is gone, its files go.
          writeFileDeletes(queueFileDeletes(readFileDeletes(), paths, Date.now()));
        } else if (!holdArchiveFiles(holdAt, task.id, paths, anyOk ? patch : null)) {
          // Task B12b (review round 25 #13): its delete is still undecided (pending, in a call, superseded): the files are
          // held for that delete's outcome (with the archived version, re-applied if the generation is kept), never queued
          // straight for deletion. No room to hold them: they stay in storage (not deleted), and the owner is told.
          setSaveStatus("error");
          setAccountToast(STORAGE_FULL_TOAST);
          setTimeout(() => setAccountToast(""), 8000);
        }
      }
      getArchiveStats().then(s => setArchiveStats(s));
      return;
    }
    if (anyOk) {
      setTasks(prev => prev.map(x => x.id === task.id
        ? { ...x, outputs: newUrls, archivedOutputs: newUrls, archivedPaths: paths, isArchived: true, archiving: false }
        : x));
      const updated = { ...task, outputs: newUrls, archivedOutputs: newUrls, archivedPaths: paths, isArchived: true };
      saveTask(updated);
      // Queue first: a failed upload is retried, and cross-device sync never reverts these URLs from the cloud.
      addFailedSync({ kind: "task", id: updated.id, data: updated });
      sendTask(updated)
        .then(() => removeFailedSync("task", updated.id, sentVersion(updated)))
        .catch(() => {})
        .finally(() => setFailedSyncCount(getFailedSyncs().length));
      setAccountToast("☁ Backed up to cloud");
    } else {
      setTasks(prev => prev.map(x => x.id === task.id ? { ...x, archiving: false } : x));
      setAccountToast("Cloud backup failed");
    }
    setTimeout(() => setAccountToast(""), 4000);
    getArchiveStats().then(s => setArchiveStats(s));
  }, []);

  const onCopyUrlTask = useCallback((task) => {
    navigator.clipboard?.writeText(task.outputs?.[0] || "");
  }, []);

  const onEditTask = useCallback((task) => {
    setSourceImageUrl(task.outputs?.[0] || "");
    setSourcePreview(task.outputs?.[0] || "");
    setUploadStatus("done");
    setGenType("i2i");
    setPrompt(task.prompt || "");
    const edit = editModelFor(task, visibleModels("i2i", providerKeysRef.current));
    setSelectedModels(edit ? [edit.id] : []);
    setPage("cockpit");
  }, []);

  const onAnimateTask = useCallback((task) => {
    setSourceImageUrl(task.outputs?.[0] || "");
    setSourcePreview(task.outputs?.[0] || "");
    setUploadStatus("done");
    setGenType("i2v");
    setSelectedModels([]);
    setPrompt("");
  }, []);

  // ─── Bulk-select / delete handlers ───
  // toggleSelect is passed to the memoized CockpitTaskCard, so it MUST be stable
  // (empty deps + functional setState) or the memo equality check breaks.
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const exitSelectMode = useCallback(() => { setSelectMode(false); setSelectedIds(new Set()); }, []);

  // Delete every task whose id is currently selected. Mirrors the existing
  // "Clear Outputs" safety pattern (snapshot first) but scoped to a chosen set,
  // and uses the preemptive failed-sync queue so a dropped cloud delete self-heals.
  const deleteSelectedTasks = async () => {
    if (bulkDeleting) return;
    const idSet = new Set(selectedIds);
    const targets = tasks.filter(t => idSet.has(t.id));
    if (targets.length === 0) { exitSelectMode(); return; }
    const n = targets.length;
    const noun = n === 1 ? "1 generation" : `${n} generations`;
    const ab = await readAutoBackups();
    if (!confirm(`Delete ${noun}? This removes ${n === 1 ? "it" : "them"} everywhere: this device, the cloud, WaveSpeed, its files and its History.\n\n${backupNotice(ab, { what: n === 1 ? "it" : "them" })}`)) return;
    const ids = targets.map(t => t.id);
    setBulkDeleting(true);
    setSaveStatus("saving");
    // 0. Mark these ids as deleting BEFORE any await, so the debounced persistence effect,
    //    the unload flush, forceSaveAll and the mount replay all refuse to re-upload them.
    for (const id of ids) deletingIds.current.add(id);
    // Task B7a (review round 20 #8): held as "being deleted" in this tab while this call runs (its intents are queued only
    // after the safety backup), released in the finally; from then on the shared queue and confirmed record decide.
    const callHold = {};
    holdDeleting("task-delete", ids, callHold);
    let heldLogIds = [], taskFlight = null;
    try {
      // 1. Safety snapshot while Automatic backups is on (the server skips it when off: ok without an id). If an
      //    expected backup can't be confirmed, abort: never destroy data without the recovery point the owner chose.
      const bk = await createBackup("pre-bulk-delete", `Before deleting ${noun}`);
      // Task B12b (review round 25 #6/#11/#14): an abort before the reservation keeps these generations; a late result
      // held for one of them meanwhile (none is when the task was still here: keepLateSubmitId attaches it) leaves the
      // hold and is linked back to it.
      const keepLate = () => { releaseAbortedLate(ids); applyRelinks(); };
      if (!bk?.ok) {
        for (const id of ids) deletingIds.current.delete(id);
        keepLate();
        setBulkDeleting(false);
        setSaveStatus("error");
        setAccountToast(`Couldn't create the safety backup (${bk?.error || "unknown error"}) — nothing was deleted.`);
        setTimeout(() => setAccountToast(""), 6000);
        return;
      }
      // 2. The plan, before anything changes. Fresh copies: a submit that answered during the backup gave its task a
      //    prediction id the snapshot lacks. Everything else this delete reaches (WaveSpeed ids, History rewrites and
      //    removals, files) is planned here; the server strips their History items in the delete's own transaction
      //    (serverHistory, review round 8). One queue time for the action (review rounds 5 and 7).
      const latest = targets.map(t => tasksRef.current.find(x => x.id === t.id) || t);
      const queuedAt = serverNow();
      const staged = planStagePurge(latest, tasksRef.current.filter(t => !idSet.has(t.id)), { serverHistory: true, holdAt: queuedAt });
      // 3. Reserve FIRST (task B12a, review round 25 #1/#17): its delete intents and the hold of its files and WaveSpeed
      //    ids, before any other change and any server call, so a tab-close or network drop replays them. No room (a full
      //    localStorage): nothing was written or changed, so the delete stops here with nothing to undo.
      if (!reserveDelete({ intents: [{ kind: "task-delete", ids, at: queuedAt }, ...staged.intents], holdAt: queuedAt, hold: staged.hold })) {
        for (const id of ids) deletingIds.current.delete(id);
        keepLate();
        setBulkDeleting(false);
        setSaveStatus("error");
        setAccountToast(STORAGE_FULL_TOAST);
        setTimeout(() => setAccountToast(""), 8000);
        return;
      }
      // 4. Stop any in-flight/queued upsert for these ids and drop their stale "task" intents,
      //    so a pending save can't recreate the cloud row after we delete it.
      if (taskSyncTimerRef.current) { clearTimeout(taskSyncTimerRef.current); taskSyncTimerRef.current = null; }
      taskSyncQueueRef.current = taskSyncQueueRef.current.filter(t => !idSet.has(t.id));
      for (const id of ids) { savedTaskIds.current.delete(id); removeFailedSync("task", id); }
      // 4a. The History changes planned above (stagePurge). A tab killed during the awaits below replays all of it.
      const plan = stagePurge(staged);
      // An older confirmation of these ids says nothing about this delete (review round 7). Forgotten only now that this
      // delete's intents are queued (task B8a, review round 21 #2/#7): they block the ids in every tab from here on, and
      // an abort above (failed safety backup, no room for the hold) leaves the confirm record exactly as it was.
      forgetConfirmed("task-delete", ids);
      // 4b. Optimistic local removal. Their ids are released, so a lost submit of the same model never adopts a deleted
      //     result. A task whose submit never answered (Cancelled and then lost to a freeze or reload) becomes a deleted
      //     claimant, so its prediction is deleted on WaveSpeed once found (review #10).
      releasePredictions(latest.map(t => t.taskId));
      const claimsBefore = claimantRecords(ids);   // put back if a restore voids this delete (review round 9)
      recordClaimants(latest, { deleted: true });
      setTasks(prev => prev.filter(t => !idSet.has(t.id)));
      // History entries this device dropped whose cloud removal is the server's (no History intent of their own): held
      // while this call runs and while this delete's intents are pending (task B7a).
      heldLogIds = plan.localRemove || [];
      holdDeleting("history-delete", heldLogIds, callHold);
      holdDeleting("history-delete", heldLogIds, queuedAt);
      // 5. Local IndexedDB delete (single transaction, awaited).
      await deleteTasks(ids);
      // 6. Cloud delete (server-checked, stamped with the action's queue time). On success, clear the replay intents.
      //    In flight for every tab until its answer is handled (task B9, review round 22 #2; the finally ends it).
      taskFlight = beginDeleteFlight({ "task-delete": ids }, queuedAt);
      const r = await deleteTasksRemote(ids, queuedAt);
      if (r.ok) confirmIntents("task-delete", ids, queuedAt);
      else if (r.deleted?.length) confirmIntents("task-delete", r.deleted, queuedAt);
      // 6b. A restore on another device that landed after this delete was queued kept some of them (voided, review round
      //     7): their intents are settled, they stop being "deleted" here, and the History work stagePurge queued is
      //     withdrawn, so nothing below rewrites or removes the restored entries. The next pass adopts the cloud's copies;
      //     items of ids that were deleted leave History through their user tombstones (tombstonedItems).
      const voided = r.voided || [];
      if (voided.length) {
        voidDeleteIntents("task-delete", voided, queuedAt);
        releaseVoided(deletingIds, "task-delete", voided);
        for (const l of plan.rewrite || []) removeFailedSync("history", l.id);
        voidDeleteIntents("history-delete", plan.remove || [], plan.historyQueuedAt);
        releaseVoided(deletingLogIds, "history-delete", plan.localRemove);
        putBackClaimants(voided, claimsBefore);   // as before the delete: a restored lost submit keeps its result (rounds 8, 9)
        giveBackVoided(queuedAt, plan.historyQueuedAt);   // round 18 #3: stashes whose ids moved to this delete
      }
      // 7. Everywhere else, now that the row delete answered: WaveSpeed, History, files (purgeEverywhere). Backup copies
      //    are scrubbed by the server (migration 20261021175100). Not after a voided delete: the cloud checks hold the
      //    WaveSpeed copies and files of what the restore kept, and its History is left to the restore.
      //    Nor after a failed one (review round 8): its queues (WaveSpeed, files, older History) replay after its row delete.
      const { note } = r.ok ? await purgeEverywhere(plan) : { note: "" };
      // 8. Refresh counters + status (honest: only say "done" when the cloud delete confirmed).
      setFailedSyncCount(getFailedSyncs().length);
      getStorageStats().then(s => setStorageStats(s));
      setBulkDeleting(false);
      exitSelectMode();
      if (r.ok) {
        setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
        setAccountToast(bk.id ? `Deleted ${noun} — safety backup saved${note}` : note ? `Deleted ${noun}${note}` : `Deleted ${noun} permanently, everywhere`);
      } else if (voided.length) {
        setSaveStatus("idle");
        setAccountToast(`A restore on another device replaced your data while this delete waited — ${voided.length === n ? (n === 1 ? "it stays" : "they stay") : `${voided.length} of them stay`} if that backup held ${voided.length === 1 ? "it" : "them"}`);
      } else {
        setSaveStatus("error");
        setAccountToast(`Removed ${noun} locally — the cloud delete will finish on your next save or reload`);
      }
      setTimeout(() => setAccountToast(""), 5000);
    } finally {
      unholdDeleting("task-delete", ids, callHold); unholdDeleting("history-delete", heldLogIds, callHold);
      endDeleteFlight(taskFlight);
    }
  };

  // Renders the selection toolbar for a given surface's candidate tasks.
  // `candidates` = the task list visible in that surface (cockpit grid, gallery tab).
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const renderSelectBar = (rawCandidates) => {
    // Only terminal (completed/failed) generations are deletable — in-flight tasks are
    // excluded from counts and bulk selection.
    const candidates = rawCandidates.filter(t => t.status === "completed" || t.status === "failed");
    const selCount = candidates.reduce((acc, t) => acc + (selectedIds.has(t.id) ? 1 : 0), 0);
    const allSelected = candidates.length > 0 && selCount === candidates.length;
    const pickExactly = (list) => setSelectedIds(new Set(list.map(t => t.id)));
    const now = Date.now();
    const expiredCount = candidates.filter(t => (now - (t.startTime || t.endTime || 0)) > SEVEN_DAYS_MS).length;
    const failedCount = candidates.filter(t => t.status === "failed").length;
    if (!selectMode) {
      return (
        <div className="sel-bar-launch">
          <button className="sel-launch" onClick={() => setSelectMode(true)}>☑ Select</button>
        </div>
      );
    }
    return (
      <div className="sel-bar">
        <div className="sel-bar-top">
          <span className="sel-count">{selCount} selected</span>
          <div className="sel-actions">
            <button className="sel-del" onClick={deleteSelectedTasks} disabled={selCount === 0 || bulkDeleting}>
              {bulkDeleting ? "Deleting…" : `🗑 Delete${selCount > 0 ? ` (${selCount})` : ""}`}
            </button>
            <button className="sel-cancel" onClick={exitSelectMode}>Cancel</button>
          </div>
        </div>
        <div className="sel-chips">
          <button className="sel-chip" onClick={() => allSelected ? setSelectedIds(new Set()) : pickExactly(candidates)}>{allSelected ? "Deselect all" : `Select all (${candidates.length})`}</button>
          {expiredCount > 0 && (
            <button className="sel-chip sel-chip-amber" onClick={() => pickExactly(candidates.filter(t => (Date.now() - (t.startTime || t.endTime || 0)) > SEVEN_DAYS_MS))}
              title="Select generations older than 7 days — WaveSpeed deletes their media after a week">⏳ Older than 7 days ({expiredCount})</button>
          )}
          {failedCount > 0 && (
            <button className="sel-chip" onClick={() => pickExactly(candidates.filter(t => t.status === "failed"))}>Failed ({failedCount})</button>
          )}
        </div>
      </div>
    );
  };

  // ─── Bulk-select / delete handlers for generation LOGS ───
  const toggleSelectLog = (id) => {
    setLogSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitLogSelectMode = () => { setLogSelectMode(false); setLogSelectedIds(new Set()); };

  // Delete every selected generation log. Mirrors deleteSelectedTasks: snapshot first
  // (abort if it fails), deletingLogIds guard, "history-delete" replay intent, honest status.
  const deleteSelectedLogs = async () => {
    if (bulkDeletingLogs) return;
    const idSet = new Set(logSelectedIds);
    const targets = logs.filter(l => idSet.has(l.id));
    if (targets.length === 0) { exitLogSelectMode(); return; }
    const n = targets.length;
    const noun = n === 1 ? "1 log entry" : `${n} log entries`;
    const ab = await readAutoBackups();
    if (!confirm(`Delete ${noun}? This removes ${n === 1 ? "it" : "them"} from this device and the cloud.\n\n${backupNotice(ab, { what: n === 1 ? "it" : "them" })}`)) return;
    const ids = targets.map(l => l.id);
    setBulkDeletingLogs(true);
    setSaveStatus("saving");
    // 0. Guard against any in-flight history upsert resurrecting these ids.
    for (const id of ids) deletingLogIds.current.add(id);
    // Task B7a (review round 20 #8): held in this tab while this call runs (intents queued after the safety backup).
    const callHold = {};
    holdDeleting("history-delete", ids, callHold);
    let logFlight = null;
    try {
      // 1. Pre-destructive snapshot (HARD RULE) — abort if it can't be confirmed.
      const bk = await createBackup("pre-bulk-delete-logs", `Before deleting ${noun}`);
      if (!bk?.ok) {
        for (const id of ids) deletingLogIds.current.delete(id);
        setBulkDeletingLogs(false);
        setSaveStatus("error");
        setAccountToast(`Couldn't create the safety backup (${bk?.error || "unknown error"}) — nothing was deleted.`);
        setTimeout(() => setAccountToast(""), 6000);
        return;
      }
      // 2. Reserve FIRST (task B12a): the cloud-delete intents, before anything changes and before firing. One queue time
      //    for the action (review rounds 5 and 8). No room (a full localStorage): nothing changed, nothing to undo.
      const queuedAt = serverNow();
      if (!reserveDelete({ intents: [{ kind: "history-delete", ids, at: queuedAt }] })) {
        for (const id of ids) deletingLogIds.current.delete(id);
        setBulkDeletingLogs(false);
        setSaveStatus("error");
        setAccountToast(STORAGE_FULL_TOAST);
        setTimeout(() => setAccountToast(""), 8000);
        return;
      }
      // 3. Drop stale "history" upsert intents for these ids.
      for (const id of ids) { savedLogIds.current.delete(id); removeFailedSync("history", id); }
      forgetConfirmed("history-delete", ids);   // only once this delete's intents are queued (task B8a, review round 21 #2/#7)
      // 4. Optimistic local removal.
      setLogs(prev => prev.filter(l => !idSet.has(l.id)));
      // 5. Local IndexedDB delete (awaited).
      await deleteHistoryEntries(ids);
      // 6. Cloud delete (restore-checked at the action's queue time, review round 8). In flight for every tab until its
      //    answer is handled (task B9; the finally ends it).
      logFlight = beginDeleteFlight({ "history-delete": ids }, queuedAt);
      const r = await deleteHistoryRemote(ids, queuedAt);
      if (r.ok) confirmIntents("history-delete", ids, queuedAt);
      else if (r.deleted.length) confirmIntents("history-delete", r.deleted, queuedAt);
      // A restore on another device that landed after this delete was queued kept some of them: they come back here.
      if (r.voided.length) {
        voidDeleteIntents("history-delete", r.voided, queuedAt);
        releaseVoided(deletingLogIds, "history-delete", r.voided);
        giveBackVoided(queuedAt);   // round 18 #3: stashes whose ids moved to this delete
      }
      // 7. Refresh counters + status (honest).
      setFailedSyncCount(getFailedSyncs().length);
      getStorageStats().then(s => setStorageStats(s));
      setBulkDeletingLogs(false);
      exitLogSelectMode();
      if (r.ok) {
        setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
        setAccountToast(bk.id ? `Deleted ${noun} — safety backup saved` : `Deleted ${noun} permanently`);
      } else if (r.voided.length) {
        setSaveStatus("idle");
        setAccountToast(`A restore on another device replaced your data while this delete waited — what that backup held stays`);
      } else {
        setSaveStatus("error");
        setAccountToast(`Removed ${noun} locally — the cloud delete will finish on your next save or reload`);
      }
      setTimeout(() => setAccountToast(""), 5000);
    } finally {
      unholdDeleting("history-delete", ids, callHold);
      endDeleteFlight(logFlight);
    }
  };

  // Selection toolbar for the generation-log list.
  const renderLogSelectBar = () => {
    const selCount = logs.reduce((acc, l) => acc + (logSelectedIds.has(l.id) ? 1 : 0), 0);
    const allSelected = logs.length > 0 && selCount === logs.length;
    const now = Date.now();
    const expiredCount = logs.filter(l => (now - (l.timestamp || 0)) > SEVEN_DAYS_MS).length;
    if (!logSelectMode) {
      return (
        <div className="sel-bar-launch">
          <button className="sel-launch" onClick={() => setLogSelectMode(true)}>☑ Select</button>
        </div>
      );
    }
    return (
      <div className="sel-bar">
        <div className="sel-bar-top">
          <span className="sel-count">{selCount} selected</span>
          <div className="sel-actions">
            <button className="sel-del" onClick={deleteSelectedLogs} disabled={selCount === 0 || bulkDeletingLogs}>
              {bulkDeletingLogs ? "Deleting…" : `🗑 Delete${selCount > 0 ? ` (${selCount})` : ""}`}
            </button>
            <button className="sel-cancel" onClick={exitLogSelectMode}>Cancel</button>
          </div>
        </div>
        <div className="sel-chips">
          <button className="sel-chip" onClick={() => allSelected ? setLogSelectedIds(new Set()) : setLogSelectedIds(new Set(logs.map(l => l.id)))}>{allSelected ? "Deselect all" : `Select all (${logs.length})`}</button>
          {expiredCount > 0 && (
            <button className="sel-chip sel-chip-amber" onClick={() => setLogSelectedIds(new Set(logs.filter(l => (Date.now() - (l.timestamp || 0)) > SEVEN_DAYS_MS).map(l => l.id)))}
              title="Select logs older than 7 days">⏳ Older than 7 days ({expiredCount})</button>
          )}
        </div>
      </div>
    );
  };

  // ─── RENDER ───
  const completedTasks = tasks.filter(t => t.status === "completed");
  const activeTasks = tasks.filter(t => t.status === "pending" || t.status === "processing");
  // resOptions and arOptions are now computed dynamically in the settings panel based on selected models
  const needsSource = ["i2i", "i2v", "v2v", "avatar", "i23d"].includes(genType);
  const selectedConfigs = selectedModels.map(id => models.find(m => m.id === id)).filter(Boolean);
  const sourceRequired = needsSource && selectedConfigs.some(m => !m.params?.sourceOptional);
  const promptRequired = genType !== "avatar" && selectedConfigs.some(m => !m.params?.noPrompt);
  const needsAudio = selectedConfigs.some(m => m.requiresAudio);
  const sourceIsVideo = genType === "v2v";

  // Second account S5 (review r6 #1): no record yet: the account is checked before anything loads.
  if (accountCheck) {
    return (
      <>
        <style>{css}</style>
        <BackgroundLayer type={background} accent={(THEMES[theme] || THEMES.default).accent} />
        <div className="proxima-app">
          <div style={{ width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box" }}>
            <div role="status" style={{ width: "100%", maxWidth: 400, padding: "28px 24px", borderRadius: 18, background: "rgba(8,12,25,0.6)", border: "1px solid rgba(99,102,241,0.2)", fontFamily: font, color: "#e2e8f0", textAlign: "center", fontSize: 13 }}>
              {accountCheck === "checking" ? (<>
                <div style={{ marginBottom: 16 }}>Checking your account…</div>
                <button type="button" className="api-test-btn" style={{ minHeight: 44, margin: 0, width: "100%" }} onClick={() => { clearSession(); setAccountCheck(null); }}>Sign out</button>
              </>) : (<>
                <div style={{ marginBottom: 16, lineHeight: 1.5 }}>Couldn't confirm your account. Check your connection and retry.</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <button type="button" className="api-test-btn" style={{ minHeight: 44, margin: 0 }} onClick={() => setAccountCheck("checking")}>Retry</button>
                  <button type="button" className="api-test-btn" style={{ minHeight: 44, margin: 0 }} onClick={() => { clearSession(); setAccountCheck(null); }}>Sign out</button>
                </div>
              </>)}
            </div>
          </div>
        </div>
      </>
    );
  }

  // Show login screen if not authenticated
  if (!isAuthed) {
    return (
      <>
        <style>{css}</style>
        <BackgroundLayer type={background} accent={(THEMES[theme] || THEMES.default).accent} />
        <div className="proxima-app">
          <LoginScreen onSignedIn={handleSignedIn} notice={sessionNotice} refusal={sessionRefusal} joinLink={joinLink} />
        </div>
        <UpdateBanner />
      </>
    );
  }

  const activeAccent = (THEMES[theme] || THEMES.default).accent;

  return (
    <>
      <style>{css}</style>
      <BackgroundLayer type={background} accent={activeAccent} paused={activeCount > 0} />
      <UpdateBanner />
      <div className="proxima-app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-logo" title="ProximaAI">◈</div>
          <button className={`sidebar-btn ${page==="cockpit"?"active":""}`} onClick={() => setPage("cockpit")} title="Cockpit">⚡</button>
          <button className={`sidebar-btn ${page==="gallery"?"active":""}`} onClick={() => setPage("gallery")} title="Gallery">🖼</button>
          <button className={`sidebar-btn ${page==="logs"?"active":""}`} onClick={() => setPage("logs")} title="Logs">📋</button>
          <button className={`sidebar-btn ${page==="settings"?"active":""}`} onClick={() => { setPage("settings"); getStorageStats().then(s => setStorageStats(s)); getArchiveStats().then(s => setArchiveStats(s)); }} title="Settings">⚙</button>
          {/* Save status (tap=force-save, long-press=full backup) — pushed to bottom on desktop */}
          <div className="sidebar-save-wrap">
            <SidebarSaveButton saveStatus={saveStatus} failedCount={failedSyncCount} onForceSave={forceSaveAll} onBackup={triggerManualBackup} />
          </div>
          {activeCount > 0 && (
            <div style={{ position: "absolute", top: 68, left: 36, background: "var(--accent)", color: "white", fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: font }} className="pulse">{activeCount}</div>
          )}
        </div>

        {/* Main */}
        <div className="main">
          <div className="topbar">
            <div className="topbar-title">ProximaAI — {page === "cockpit" ? "GENERATION COCKPIT" : page === "gallery" ? "SAVED OUTPUTS" : page === "logs" ? "GENERATION LOG" : "SETTINGS"}</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {balance !== null && !keyBlocked && <div className="balance-pill">${Number(balance).toFixed(2)}</div>}
              {keyBlocked && <span style={{ fontSize: 11, color: "var(--error)" }}>⚠ {keyStatus === "invalid" ? "API key rejected" : "No API Key"}</span>}
              {kieKeyStatus === "invalid" && <span style={{ fontSize: 11, color: "var(--error)" }}>⚠ kie.ai key rejected</span>}
            </div>
          </div>

          <div className="content">
            {/* ═══ COCKPIT ═══ */}
            {page === "cockpit" && (
              <div className="cockpit">
                <div className="cockpit-left">
                  {/* Type Tabs */}
                  <div className="type-tabs-wrap" ref={el => {
                    if (!el) return;
                    const tabs = el.querySelector('.type-tabs');
                    if (!tabs) return;
                    const updateFade = () => {
                      const maxScroll = tabs.scrollWidth - tabs.clientWidth;
                      if (maxScroll > 2 && tabs.scrollLeft < maxScroll - 2) {
                        el.classList.add('has-overflow');
                      } else {
                        el.classList.remove('has-overflow');
                      }
                    };
                    updateFade();
                    tabs.onscroll = updateFade;
                    if (!el._resizeObs) {
                      el._resizeObs = new ResizeObserver(updateFade);
                      el._resizeObs.observe(tabs);
                    }
                  }}>
                    <div className="type-tabs">
                      {Object.entries(TYPE_LABELS).map(([key, label]) => (
                        <button key={key} className={`type-tab ${genType===key?"active":""}`}
                          onClick={e => {
                            setGenType(key); setSelectedModels([]); setPerModelRes({}); setResolution(""); setDuration(5); setAspectRatio("auto"); setSourceImageUrls([]);
                            if (!["i2i", "i2v", "v2v", "avatar", "i23d"].includes(key)) { clearSourceImage(); }
                            // Scroll selected tab into view (desktop only — mobile shows all 5 in one row)
                            if (window.innerWidth > 768) e.currentTarget.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                          }}>
                          <span className="tab-icon">{TYPE_ICONS[key] || (key === "v2v" ? "🎞️" : "◈")}</span>
                          <span className="tab-label tab-label-full">{label}</span>
                          <span className="tab-label tab-label-short">{({ image: "Image", i2i: "Edit", i23d: "3D", t2v: "T→V", i2v: "I→V", v2v: "V→V", avatar: "Avatar" }[key] || label)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Prompt */}
                  <div className="card">
                    <div className="card-title">{genType === "i2i" || genType === "v2v" ? "Edit Instructions" : "Prompt"}</div>
                    <textarea className="prompt-area" placeholder={
                      genType === "i2i" ? "Describe the edit you want... (e.g., 'Change the background to a sunset beach')" :
                      genType === "i2v" ? "Describe the motion... (e.g., 'Slow camera push-in, subtle movement')" :
                      genType === "v2v" ? "Describe how to edit or extend the source video..." :
                      "Describe what you want to generate..."}
                      value={prompt} onChange={e => setPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate(); }} />
                    {(genType === "image" || genType === "i2i" || genType === "t2v" || genType === "i2v") && (
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", marginTop: 8, fontSize: 12, padding: 8 }}
                        placeholder="Negative prompt (optional)..." value={negPrompt} onChange={e => setNegPrompt(e.target.value)} />
                    )}
                  </div>

                  {/* Source media — image, video, or reference frames by workflow */}
                  {needsSource && (
                    <div className="card">
                      <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Source {sourceIsVideo ? "Video" : "Image"}{sourceRequired ? " *" : " (optional)"}</span>
                        {uploadStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded to WaveSpeed</span>}
                        {uploadStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                        {uploadStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                      </div>

                      {/* Hidden file input — triggers native picker, multiple when multi-image models selected */}
                      <input type="file" ref={fileInputRef} accept={sourceIsVideo ? "video/*" : "image/*"}
                        multiple={!sourceIsVideo && ['i2i', 'i2v', 'avatar'].includes(genType) && maxImagesAllowed > 1}
                        style={{ display: "none" }} onChange={handleFileSelect} />

                      {/* Upload + URL buttons */}
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <button onClick={() => fileInputRef.current?.click()}
                          style={{
                            flex: 1, padding: "12px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)",
                            borderRadius: 10, color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
                            fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s", display: "flex",
                            flexDirection: "column", alignItems: "center", gap: 4
                          }}
                          onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-glow)"; }}
                          onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-input)"; }}>
                          <span style={{ fontSize: 24 }}>📁</span>
                          <span>{!sourceIsVideo && maxImagesAllowed > 1 ? "Upload Images" : `Upload ${sourceIsVideo ? "Video" : "from Device"}`}</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{!sourceIsVideo && maxImagesAllowed > 1 ? `Select up to ${maxImagesAllowed} images` : sourceIsVideo ? "Videos · Files" : "Gallery · Photos · Files"}</span>
                        </button>
                      </div>

                      {/* OR divider */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px" }}>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font }}>OR PASTE URL</span>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      </div>

                      {/* URL input */}
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                        placeholder={sourceIsVideo ? "https://example.com/video.mp4" : "https://example.com/image.png"}
                        value={sourceImageUrl}
                        onChange={e => { setSourceImageUrl(e.target.value); setSourcePreview(e.target.value); setUploadStatus(e.target.value ? "done" : ""); }} />

                      {/* Preview */}
                      {(sourcePreview || sourceImageUrl) && (
                        <div style={{ marginTop: 10, position: "relative" }}>
                          {sourceIsVideo ? (
                            <video src={sourcePreview || sourceImageUrl} controls muted playsInline
                              style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }} />
                          ) : (
                            <img src={sourcePreview || sourceImageUrl} alt="Source"
                              style={{ width: "100%", maxHeight: 180, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }}
                              onError={e => { e.target.style.display = "none"; setUploadStatus("error"); }} />
                          )}
                          {!sourceIsVideo && ['i2i', 'i2v', 'avatar'].includes(genType) && maxImagesAllowed > 1 && (
                            <div style={{ position: "absolute", bottom: 6, left: 6, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 10, padding: "2px 6px", borderRadius: 4, fontFamily: font, fontWeight: 600 }}>Ref 1</div>
                          )}
                          <button onClick={clearSourceImage}
                            style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.8)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                          {uploadStatus === "uploading" && (
                            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <div className="pulse" style={{ color: "white", fontFamily: font, fontSize: 13 }}>Uploading to WaveSpeed...</div>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                        {genType === "i2i" ? "Upload the image(s) you want to edit. Your prompt describes what to change." :
                         genType === "i2v" ? "Upload a first frame or reference images. A second image is used as the last frame by supported models." :
                         genType === "v2v" ? "Upload the video you want to edit, extend, reframe, control, or upscale." :
                         sourceIsVideo ? "Upload the source video for this avatar workflow." : "Upload the source image for this workflow."}
                        {uploadStatus === "done" && sourceImageUrl && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-secondary)", fontFamily: font, fontSize: 9, wordBreak: "break-all" }}>
                            {sourceImageUrl.length > 60 ? sourceImageUrl.slice(0, 60) + "..." : sourceImageUrl}
                          </span>
                        )}
                      </div>

                      {/* Multi-image references / end frame */}
                      {['i2i', 'i2v', 'avatar'].includes(genType) && maxImagesAllowed > 1 && uploadStatus === "done" && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, fontFamily: font }}>
                            Additional Reference Images ({sourceImageUrls.length}/{Math.max(0, maxImagesAllowed - 1)} max)
                          </div>
                          {/* Thumbnails of additional images */}
                          {sourceImageUrls.length > 0 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                              {sourceImageUrls.map((url, i) => (
                                <div key={i} style={{ position: "relative", width: 60, height: 60 }}>
                                  <img src={url} alt={`Ref ${i+2}`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                                  <div style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 8, padding: "1px 4px", borderRadius: 3, fontFamily: font }}>Ref {i+2}</div>
                                  <button onClick={() => setSourceImageUrls(prev => prev.filter((_, j) => j !== i))}
                                    style={{ position: "absolute", top: -4, right: -4, background: "var(--error)", color: "white", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                          {sourceImageUrls.length < maxImagesAllowed - 1 && (
                            <>
                              {/* Hidden file input for gallery picker */}
                              <input type="file" ref={multiImageFileRef} accept="image/*" multiple style={{ display: "none" }}
                                onChange={handleAdditionalFileSelect} />
                              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                                <button onClick={() => multiImageFileRef.current?.click()}
                                  style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s" }}
                                  onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                                  onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
                                  📁 Upload More from Gallery
                                </button>
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input ref={multiImageInputRef} type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 11, padding: 8, flex: 1 }}
                                  placeholder="Or paste image URL..."
                                  onKeyDown={e => {
                                    if (e.key === "Enter" && e.target.value.trim()) {
                                      e.preventDefault();
                                      setSourceImageUrls(prev => [...prev, e.target.value.trim()]);
                                      e.target.value = "";
                                    }
                                  }} />
                                <button onClick={() => {
                                  const input = multiImageInputRef.current;
                                  if (input?.value?.trim()) { setSourceImageUrls(prev => [...prev, input.value.trim()]); input.value = ""; }
                                }} style={{ padding: "8px 12px", background: "var(--accent)", color: "white", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: font, whiteSpace: "nowrap" }}>+ Add</button>
                              </div>
                            </>
                          )}
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
                            {selectedConfigs.some(m => m.id === "krea/v3/edit")
                              ? 'Krea 3 supports up to 8 references. Name them "<image-1>", "<image-2>", etc. in the prompt.'
                              : selectedConfigs.some(m => m.params?.auxImageParam === "mask_image")
                              ? "Ref 2 is the required mask image."
                              : selectedConfigs.some(m => m.params?.auxImageParam === "face_image")
                                ? "Ref 2 is the required replacement-face image."
                                : selectedConfigs.some(m => m.params?.productImageParam)
                                  ? "Ref 2 is the product image; placement is available in Advanced parameters."
                                  : 'Reference images can be named as "Figure 1", "Figure 2", etc. in the prompt.'}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* End frame — last_image/end_image/start+end workflows */}
                  {genType === "i2v" && (() => {
                    const ef = selectedModels.map(id => models.find(m => m.id === id))
                      .filter(m => m?.params?.endFrame || m?.params?.lastImageParam || m?.params?.startEndFrames);
                    if (ef.length === 0) return null;
                    return (
                      <div className="card">
                        <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>End Frame</span>
                          {endFrameStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded</span>}
                          {endFrameStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                          {endFrameStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                        </div>
                        <input type="file" ref={endFrameInputRef} accept="image/*" style={{ display: "none" }} onChange={handleEndFrameSelect} />
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <button onClick={() => endFrameInputRef.current?.click()}
                            style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody }}>📁 Upload end frame</button>
                        </div>
                        <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                          placeholder="Or paste end-frame image URL..." value={endFrameUrl}
                          onChange={e => { setEndFrameUrl(e.target.value); setEndFramePreview(e.target.value); setEndFrameStatus(e.target.value ? "done" : ""); }} />
                        {(endFramePreview || endFrameUrl) && (
                          <div style={{ marginTop: 10, position: "relative" }}>
                            <img src={endFramePreview || endFrameUrl} alt="End frame" style={{ width: "100%", maxHeight: 160, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }} onError={e => { e.target.style.display = "none"; }} />
                            <button onClick={() => { setEndFrameUrl(""); setEndFramePreview(""); setEndFrameStatus(""); }}
                              style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.8)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13 }}>✕</button>
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                          Last frame for supported interpolation workflows. Required models are validated before submission. ({ef.map(m => m.name).join(", ")})
                        </div>
                      </div>
                    );
                  })()}

                  {/* C2: Reference Video — for i2v models that declare params.referenceVideos (videos[]) */}
                  {genType === "i2v" && (() => {
                    const rv = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.referenceVideos);
                    if (rv.length === 0) return null;
                    return (
                      <div className="card">
                        <div className="card-title"><span>Reference Video *</span></div>
                        <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                          placeholder="Paste reference video URL (mp4)..." value={refVideoUrl}
                          onChange={e => setRefVideoUrl(e.target.value)} />
                        {refVideoUrl && (
                          <video src={refVideoUrl} style={{ width: "100%", maxHeight: 160, marginTop: 10, borderRadius: 8, border: "1px solid var(--border)", background: "#000" }} controls muted />
                        )}
                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                          Required reference video URL. ({rv.map(m => m.name).join(", ")})
                        </div>
                      </div>
                    );
                  })()}

                  {/* C3: Avatar source audio — for avatar models that require audio */}
                  {genType === "avatar" && (() => {
                    const am = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.requiresAudio);
                    if (am.length === 0) return null;
                    return (
                      <div className="card">
                        <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Source Audio *</span>
                          {sourceAudioStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded</span>}
                          {sourceAudioStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                          {sourceAudioStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                        </div>
                        <input type="file" ref={audioInputRef} accept="audio/*" style={{ display: "none" }} onChange={handleAudioSelect} />
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <button onClick={() => audioInputRef.current?.click()}
                            style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody }}>🎙️ Upload audio</button>
                        </div>
                        <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                          placeholder="Or paste audio URL (mp3/wav)..." value={sourceAudioUrl}
                          onChange={e => { setSourceAudioUrl(e.target.value); setSourceAudioStatus(e.target.value ? "done" : ""); }} />
                        {sourceAudioUrl && <audio src={sourceAudioUrl} controls style={{ width: "100%", marginTop: 10 }} />}
                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                          Voice/speech audio the avatar lip-syncs to. ({am.map(m => m.name).join(", ")})
                        </div>
                      </div>
                    );
                  })()}

                  {/* C3: Avatar driving video — for avatar models that require video */}
                  {genType === "avatar" && (() => {
                    const vm = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.requiresVideo);
                    if (vm.length === 0) return null;
                    return (
                      <div className="card">
                        <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Driving Video *</span>
                          {sourceVideoStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded</span>}
                          {sourceVideoStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                          {sourceVideoStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                        </div>
                        <input type="file" ref={videoInputRef} accept="video/*" style={{ display: "none" }} onChange={handleAvatarVideoSelect} />
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <button onClick={() => videoInputRef.current?.click()}
                            style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody }}>🎬 Upload video</button>
                        </div>
                        <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                          placeholder="Or paste driving video URL (mp4)..." value={sourceVideoUrl}
                          onChange={e => { setSourceVideoUrl(e.target.value); setSourceVideoStatus(e.target.value ? "done" : ""); }} />
                        {sourceVideoUrl && <video src={sourceVideoUrl} controls muted style={{ width: "100%", maxHeight: 160, marginTop: 10, borderRadius: 8, border: "1px solid var(--border)", background: "#000" }} />}
                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                          Driving/reference video for body motion. ({vm.map(m => m.name).join(", ")})
                        </div>
                      </div>
                    );
                  })()}

                  {/* Model Selector */}
                  <div className="card">
                    <div className="card-title model-selector-header">
                      <span aria-live="polite">Models — {selectedModels.length} selected</span>
                      <div className="model-actions">
                        <button type="button"
                          className={`model-action-btn favorites ${categoryFavoritesSelected ? "active" : ""}`}
                          title={categoryFavoriteIds.length > 0 ? `Select ${categoryFavoriteIds.length} favorite model${categoryFavoriteIds.length === 1 ? "" : "s"} in ${TYPE_LABELS[genType]}` : `No favorite models saved in ${TYPE_LABELS[genType]}`}
                          aria-label={categoryFavoriteIds.length > 0 ? `Select all ${categoryFavoriteIds.length} favorite models in ${TYPE_LABELS[genType]}` : `No favorite models in ${TYPE_LABELS[genType]}`}
                          aria-pressed={categoryFavoritesSelected}
                          disabled={categoryFavoriteIds.length === 0}
                          onClick={() => setSelectedModels(categoryFavoriteIds)}>
                          ★ FAV {categoryFavoriteIds.length}
                        </button>
                        <button type="button" className="model-action-btn" title="Select all models"
                          aria-label={`Select all ${models.length} models in ${TYPE_LABELS[genType]}`}
                          onClick={() => setSelectedModels(models.map(m => m.id))}>ALL</button>
                        <button type="button" className="model-action-btn clear" title="Deselect all models"
                          aria-label={`Deselect all models in ${TYPE_LABELS[genType]}`}
                          onClick={() => setSelectedModels([])} disabled={selectedModels.length === 0}>NONE</button>
                      </div>
                    </div>
                    <div className="model-grid">
                      {models.map(m => {
                        const isSelected = selectedModels.includes(m.id);
                        const isFavorite = categoryFavoriteSet.has(m.id);
                        return (
                          <div key={m.id} className={`model-item ${isSelected ? "selected" : ""}`}>
                            <button type="button" className="model-choice" aria-pressed={isSelected} title={m.name}
                              aria-label={`${isSelected ? "Deselect" : "Select"} ${m.name}`}
                              onClick={() => toggleModel(m.id)}>
                              <span className="model-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                              <span className="model-name">{m.name}</span>
                              <span className="model-meta">
                                {m.hot && <span className="hot-badge">HOT</span>}
                                {m.flagship && <span className="hot-badge" style={{ background: "var(--accent)" }}>★</span>}
                                <span className="model-provider" style={{ background: (PROVIDER_COLORS[m.provider]||"#666")+"22", color: PROVIDER_COLORS[m.provider]||"#aaa" }}>{m.provider}</span>
                                {(() => {
                                  const q = unitQuotes.get(m.id) || { cost: m.price, exact: true };
                                  const title = q.exact
                                    ? `One generation at your current settings (default settings: ${formatCost(m.price)})`
                                    : "Default-settings price: an input's length is not measured yet";
                                  return <span className="model-price" title={title}>{q.exact ? "" : "~"}{formatCost(q.cost)}</span>;
                                })()}
                              </span>
                            </button>
                            <button type="button" className={`model-favorite-btn ${isFavorite ? "active" : ""}`}
                              aria-pressed={isFavorite}
                              aria-label={`${isFavorite ? "Remove" : "Add"} ${m.name} ${isFavorite ? "from" : "to"} favorites`}
                              title={`${isFavorite ? "Remove from" : "Add to"} ${TYPE_LABELS[genType]} favorites`}
                              onClick={() => toggleFavoriteModel(genType, m.id)}>
                              <span aria-hidden="true">{isFavorite ? "★" : "☆"}</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Dynamic Settings — adapts to selected models (UNION-based) */}
                  <div className="card">
                    <div className="card-title">Settings {selectedModels.length > 0 ? `(${selectedModels.length} model${selectedModels.length > 1 ? "s" : ""})` : ""}</div>
                    {selectedModels.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Select models to see parameters</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {/* Resolution — UNION of all selected models' options */}
                        {(() => {
                          const selectedWithRes = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.resolution);
                          if (selectedWithRes.length === 0) return null;
                          // Group by param scheme (paramName)
                          const schemes = {};
                          selectedWithRes.forEach(m => {
                            const key = m.params.resolution.paramName;
                            if (!schemes[key]) schemes[key] = [];
                            schemes[key].push(m);
                          });
                          const schemeKeys = Object.keys(schemes);
                          // If all share same scheme, show one dropdown with UNION of options
                          if (schemeKeys.length === 1) {
                            const modelsInScheme = schemes[schemeKeys[0]];
                            // Build UNION: deduplicate by value, track which models support each
                            const optMap = new Map();
                            modelsInScheme.forEach(m => {
                              m.params.resolution.options.forEach(o => {
                                if (!optMap.has(o.value)) optMap.set(o.value, { label: o.label, value: o.value, models: [] });
                                optMap.get(o.value).models.push(m.name);
                              });
                            });
                            const unionOptions = [...optMap.values()];
                            const totalModels = modelsInScheme.length;
                            // Auto-set resolution if current value is not in union
                            const validVals = unionOptions.map(o => o.value);
                            if (!validVals.includes(resolution)) {
                              setTimeout(() => setResolution(modelsInScheme[0].params.resolution.default), 0);
                            }
                            return (
                              <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <label>Resolution</label>
                                  <select className="settings-select" value={resolution} onChange={e => setResolution(e.target.value)}>
                                    {unionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </div>
                                {totalModels > 1 && (() => {
                                  const current = optMap.get(resolution);
                                  if (current && current.models.length < totalModels) {
                                    const unsupported = modelsInScheme.filter(m => !current.models.includes(m.name));
                                    return (
                                      <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                        {current.models.length === totalModels ? "All models" : current.models.join(", ")}
                                        {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {resolutionNotes(unsupported, resolution).map(x => `${x.name} uses ${x.label}`).join(", ")}</span>}
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                            );
                          }
                          // Different schemes — show per-model dropdowns
                          return selectedWithRes.map(m => (
                            <div className="settings-row" key={m.id}>
                              <label htmlFor={`res-${m.id}`} style={{ fontSize: 10, minWidth: 80 }}>{m.name}</label>
                              <select id={`res-${m.id}`} className="settings-select" value={chosenResolution(m, { perModelResolution: effectivePerModel, resolution })}
                                onChange={e => setPerModelRes(prev => ({ ...prev, [m.id]: e.target.value }))}>
                                {m.params.resolution.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          ));
                        })()}

                        {/* Aspect ratio — UNION with support indicators */}
                        {(() => {
                          const withAR = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.aspectRatio);
                          if (withAR.length === 0) return null;
                          // Build UNION of all aspect ratio options, track supporters
                          const arMap = new Map();
                          withAR.forEach(m => {
                            m.params.aspectRatio.options.forEach(o => {
                              if (!arMap.has(o.value)) arMap.set(o.value, { label: o.label, value: o.value, models: [] });
                              arMap.get(o.value).models.push(m.name);
                            });
                          });
                          const unionAR = [...arMap.values()];
                          const totalAR = withAR.length;
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Aspect</label>
                                <select className="settings-select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                  <option value="auto">Auto</option>
                                  {unionAR.map(o => <option key={o.value} value={o.value}>{o.label}{totalAR > 1 && o.models.length < totalAR ? ` (${o.models.length}/${totalAR})` : ""}</option>)}
                                </select>
                              </div>
                              {totalAR > 1 && aspectRatio !== "auto" && (() => {
                                const current = arMap.get(aspectRatio);
                                if (current && current.models.length < totalAR) {
                                  const unsupported = withAR.filter(m => !current.models.includes(m.name));
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      {current.models.join(", ")}
                                      {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {unsupported.map(m => m.name).join(", ")} will use their default</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {/* Duration — UNION for video models with per-model fallback */}
                        {(genType === "t2v" || genType === "i2v" || genType === "v2v") && (() => {
                          const withDur = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.duration);
                          if (withDur.length === 0) return null;
                          // Build UNION of all duration options, track which models support each
                          const durMap = new Map();
                          withDur.forEach(m => {
                            m.params.duration.options.forEach(d => {
                              if (!durMap.has(d)) durMap.set(d, []);
                              durMap.get(d).push(m.name);
                            });
                          });
                          const unionDurs = [...durMap.keys()].sort((a, b) => a - b);
                          const totalDur = withDur.length;
                          // Auto-correct if current duration is not in union at all
                          if (!unionDurs.includes(Number(duration))) {
                            setTimeout(() => setDuration(unionDurs[0]), 0);
                          }
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Duration</label>
                                <select className="settings-select" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                                  {unionDurs.map(d => {
                                    const supporters = durMap.get(d);
                                    const suffix = totalDur > 1 && supporters.length < totalDur ? ` (${supporters.length}/${totalDur})` : "";
                                    return <option key={d} value={d}>{d}s{suffix}</option>;
                                  })}
                                </select>
                              </div>
                              {totalDur > 1 && (() => {
                                const currentDur = Number(duration);
                                const supporters = durMap.get(currentDur) || [];
                                if (supporters.length < totalDur) {
                                  const unsupported = withDur.filter(m => !m.params.duration.options.includes(currentDur));
                                  // Show what fallback each unsupported model gets
                                  const fallbackInfo = unsupported.map(m => {
                                    const opts = m.params.duration.options;
                                    const closest = opts.reduce((prev, curr) => Math.abs(curr - currentDur) < Math.abs(prev - currentDur) ? curr : prev);
                                    return `${m.name} -> ${closest}s`;
                                  });
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      <span>{supporters.length === totalDur ? "All models" : supporters.join(", ")}</span>
                                      {fallbackInfo.length > 0 && <span style={{ color: "var(--amber)" }}> — {fallbackInfo.join(", ")}</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {(genType === "image" || genType === "i2i") && (() => {
                          // C4: cap the batch options to each selected model's actual max (maxBatchImages||4)
                          const maxBatch = Math.min(16, ...selectedModels.map(id => getImageBatchLimit(models.find(x => x.id === id))));
                          const opts = Array.from({ length: maxBatch }, (_, i) => i + 1);
                          return (
                            <div className="settings-row">
                              <label>Batch</label>
                              <select className="settings-select" value={Math.min(numImages, maxBatch)} onChange={e => setNumImages(Number(e.target.value))}>
                                {opts.map(n => <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>)}
                              </select>
                            </div>
                          );
                        })()}

                        <div className="settings-row">
                          <label>Seed</label>
                          <input type="text" className="settings-input" style={{ width: 72 }} value={seed} onChange={e => setSeed(e.target.value)} />
                          <button onClick={() => setSeed(Math.floor(Math.random() * 999999).toString())} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontSize: 14 }} title="Random seed">🎲</button>
                        </div>

                        {/* C1: Advanced per-model parameters — driven by each selected model's params.optional + params.briaPreset */}
                        {(() => {
                          const sel = selectedModels.map(id => models.find(m => m.id === id)).filter(Boolean);
                          const optMap = new Map();
                          sel.forEach(m => {
                            if (m.params?.optional) {
                              for (const [key, cfg] of Object.entries(m.params.optional)) {
                                if (!optMap.has(key)) optMap.set(key, { key, cfg, models: [] });
                                optMap.get(key).models.push(m.name);
                              }
                            }
                          });
                          const opts = [...optMap.values()];
                          const briaModels = sel.filter(m => m.params?.briaPreset);
                          if (opts.length === 0 && briaModels.length === 0) return null;
                          const labelOf = k => k.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim().replace(/^./, c => c.toUpperCase());
                          return (
                            <details style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                              <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--text-secondary)", userSelect: "none" }}>
                                ⚙️ Advanced parameters ({opts.length + briaModels.length})
                              </summary>
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                {opts.map(({ key, cfg, models: ms }) => {
                                  const cur = optionalParams[key] !== undefined ? optionalParams[key] : cfg.default;
                                  const note = ms.length < sel.length ? ` (${ms.length}/${sel.length})` : "";
                                  if (cfg.type === "boolean") {
                                    return (
                                      <div className="settings-row" key={key}>
                                        <label title={ms.join(", ")}>{labelOf(key)}{note}</label>
                                        <input type="checkbox" checked={!!cur} onChange={e => setOptionalParams(p => ({ ...p, [key]: e.target.checked }))} />
                                      </div>
                                    );
                                  }
                                  if (cfg.type === "enum") {
                                    return (
                                      <div className="settings-row" key={key}>
                                        <label title={ms.join(", ")}>{labelOf(key)}{note}</label>
                                        <select className="settings-select" value={cur} onChange={e => setOptionalParams(p => ({ ...p, [key]: e.target.value }))}>
                                          {cfg.values.map(v => <option key={v} value={v}>{v}</option>)}
                                        </select>
                                      </div>
                                    );
                                  }
                                  const step = (cfg.max != null && cfg.max <= 1) ? 0.05 : (Number.isInteger(cfg.default) ? 1 : 0.1);
                                  return (
                                    <div className="settings-row" key={key}>
                                      <label title={ms.join(", ")}>{labelOf(key)}{note}</label>
                                      <input type="number" className="settings-input" style={{ width: 80 }} value={cur} min={cfg.min} max={cfg.max} step={step}
                                        onChange={e => setOptionalParams(p => ({ ...p, [key]: e.target.value === "" ? cfg.default : parseFloat(e.target.value) }))} />
                                      {cfg.min != null && <span style={{ fontSize: 9, color: "var(--text-secondary)" }}>{cfg.min}–{cfg.max}</span>}
                                    </div>
                                  );
                                })}
                                {briaModels.map(m => {
                                  const cur = briaPresets[m.id] !== undefined ? briaPresets[m.id] : m.params.briaPreset.default;
                                  return (
                                    <div className="settings-row" key={m.id}>
                                      <label title={m.name}>{m.name}</label>
                                      <select className="settings-select" value={cur} onChange={e => setBriaPresets(p => ({ ...p, [m.id]: e.target.value }))}>
                                        {m.params.briaPreset.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                      </select>
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          );
                        })()}
                      </div>
                    )}
                  </div>

                  {/* Cost + Generate — sticky on mobile, inline on desktop */}
                  <div className="action-panel">
                    {selectedModels.length > 0 && (
                      <div className="cost-bar">
                        <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Est. cost ({selectedConfigs.length} model{selectedConfigs.length > 1 ? "s" : ""})</span>
                        <span className="cost-amount" title={estExact ? "WaveSpeed price for these settings" : "Includes a default-settings price: an input's length is not measured yet"}>{estExact ? "" : "~"}{formatCost(estCost)}</span>
                      </div>
                    )}

                    <button className={`gen-btn ${isGenerating ? "running" : "ready"}`}
                      disabled={keyBlocked || (promptRequired && !prompt.trim()) || selectedConfigs.length === 0 || (sourceRequired && !sourceImageUrl.trim()) || (needsAudio && !sourceAudioUrl.trim())}
                      onClick={handleGenerate}>
                      {isGenerating ? `⏳ GENERATING (${activeCount} active)...` :
                       keyBlocked ? (keyStatus === "invalid" ? "⚠ UPDATE API KEY IN SETTINGS" : "⚠ SET API KEY IN SETTINGS") :
                       sourceRequired && !sourceImageUrl.trim() ? `⚠ ADD SOURCE ${sourceIsVideo ? "VIDEO" : "IMAGE"} ABOVE` :
                       needsAudio && !sourceAudioUrl.trim() ? "⚠ ADD SOURCE AUDIO ABOVE" :
                       `⚡ ${genType === "i2i" || genType === "v2v" ? "EDIT" : "GENERATE"}${selectedConfigs.length > 0 ? ` ACROSS ${selectedConfigs.length} MODELS` : ""}`}
                    </button>
                    <div className="gen-hint" style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center" }}>Ctrl+Enter to generate</div>
                  </div>
                </div>

                {/* Results */}
                <div className="cockpit-right">
                  {tasks.length === 0 ? (
                    <div className="empty-state">
                      <div className="emoji">◈</div>
                      <div className="msg">Select models, write a prompt, and hit Generate to fire parallel requests across all selected models simultaneously.</div>
                    </div>
                  ) : (
                    <>
                      {renderSelectBar(tasks)}
                      <div className="results-grid">
                        {tasks.map(task => (
                          <CockpitTaskCard
                            key={task.id}
                            task={task}
                            currentGenType={genType}
                            onRegenerate={regenerateTask}
                            onCancel={cancelTask}
                            onDownload={onDownloadTask}
                            onCloudArchive={onCloudArchiveTask}
                            onCopyUrl={onCopyUrlTask}
                            onEdit={onEditTask}
                            onAnimate={onAnimateTask}
                            onLightbox={setLightbox}
                            selectMode={selectMode}
                            selected={selectedIds.has(task.id)}
                            onToggleSelect={toggleSelect}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ═══ GALLERY ═══ */}
            {page === "gallery" && (() => {
              const galleryCompleted = tasks.filter(t => t.status === "completed");
              const galleryProcessing = tasks.filter(t => t.status === "pending" || t.status === "processing");
              const galleryFailed = tasks.filter(t => t.status === "failed");
              const [galleryTab, setGalleryTab] = [galleryTabState, setGalleryTabState];
              const tabCounts = { completed: galleryCompleted.length, processing: galleryProcessing.length, failed: galleryFailed.length };
              return (
              <div>
                {/* Gallery Tabs */}
                <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "rgba(10,20,40,0.3)", borderRadius: 10, padding: 3 }}>
                  {[["completed","Completed"],["processing","Processing"],["failed","Failed"]].map(([key,label]) => (
                    <button key={key} onClick={() => setGalleryTabState(key)}
                      style={{ flex: 1, padding: "8px 6px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s",
                        background: galleryTab === key ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "transparent",
                        color: galleryTab === key ? "white" : "var(--text-muted)",
                        boxShadow: galleryTab === key ? "0 2px 8px rgba(99,102,241,0.3)" : "none" }}>
                      {label} ({tabCounts[key]})
                    </button>
                  ))}
                </div>

                {/* Bulk-select bar — completed + failed tabs (in-flight tasks aren't deletable) */}
                {(galleryTab === "completed" ? galleryCompleted : galleryTab === "failed" ? galleryFailed : []).length > 0 &&
                  renderSelectBar(galleryTab === "completed" ? galleryCompleted : galleryFailed)}

                {/* View Toggle — only for completed tab (hidden while selecting; selection forces list view) */}
                {galleryTab === "completed" && galleryCompleted.length > 0 && !selectMode && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10, gap: 4 }}>
                    <button onClick={() => setGalleryView("masonry")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "masonry" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "masonry" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Masonry grid view">⊞</button>
                    <button onClick={() => setGalleryView("vertical")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "vertical" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "vertical" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Vertical list view">☰</button>
                  </div>
                )}

                {/* Completed outputs */}
                {galleryTab === "completed" && (
                  galleryCompleted.length === 0 ? (
                    <div className="empty-state"><div className="emoji">🖼️</div><div className="msg">Completed outputs will appear here.</div></div>
                  ) : (!selectMode && galleryView === "masonry") ? (
                    /* 3-column thumbnail grid — tap to lightbox, long-press for info */
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                      {galleryCompleted.flatMap(task =>
                        (task.outputs || []).map((url, i) => {
                          const gType = task.genType || "";
                          const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "v2v" || gType === "avatar";
                          return (
                            <div key={`${task.id}-${i}`} style={{ position: "relative", aspectRatio: "1", overflow: "hidden", borderRadius: 6, cursor: "pointer", background: "#111" }}
                              onClick={() => setLightbox(url)}
                              onContextMenu={e => { e.preventDefault(); setLightbox({ url, task }); }}>
                              {isVideo
                                ? <video src={url} muted playsInline preload="none" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                : <img src={url} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                              {isVideo && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 24, color: "white", textShadow: "0 1px 4px rgba(0,0,0,0.6)", pointerEvents: "none" }}>▶</div>}
                              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 4px 3px", background: "linear-gradient(transparent, rgba(0,0,0,0.7))", fontSize: 8, color: "rgba(255,255,255,0.8)", fontFamily: font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {task.modelName}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  ) : (
                    /* Vertical list — full-width previews with detailed info */
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {galleryCompleted.map(task => (
                        <div key={task.id} className={`task-card${selectMode ? " selecting-card" : ""}${selectMode && selectedIds.has(task.id) ? " card-selected" : ""}`}
                          onClick={selectMode ? () => toggleSelect(task.id) : undefined}
                          style={selectMode ? { cursor: "pointer", position: "relative" } : undefined}>
                          {selectMode && <div aria-hidden="true" className={`select-check${selectedIds.has(task.id) ? " on" : ""}`}>{selectedIds.has(task.id) ? "✓" : ""}</div>}
                          <div className="task-header">
                            <span className="task-model">{task.modelName}{task.batchImageIndex && task.requestedImages > 1 && <span className="task-batch-index">{task.batchImageIndex}/{task.requestedImages}</span>}</span>
                            <span className="task-status completed">COMPLETED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{task.prompt}</div>
                          {task.outputs?.map((url, i) => {
                            const gType = task.genType || "";
                            const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "v2v" || gType === "avatar";
                            return isVideo
                              ? <video key={i} className="result-video" src={url} controls muted playsInline preload="none" onClick={selectMode ? undefined : () => setLightbox(url)} style={selectMode ? { pointerEvents: "none" } : undefined} />
                              : <img key={i} className="result-img" src={url} alt="" loading="lazy" decoding="async" onClick={selectMode ? undefined : () => setLightbox(url)} style={selectMode ? { pointerEvents: "none" } : undefined} />;
                          })}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
                            <span>{task.provider}</span>
                            <span>{formatTime(task.wallClockMs)}</span>
                            <span>{formatCost(task.price)}</span>
                            <span>{task.endTime ? formatTimestamp(task.endTime) : timeAgo(task.endTime)}</span>
                          </div>
                          {task.sourceImageUrl && (
                            <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                              Source: <a href={task.sourceImageUrl} target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>{task.sourceImageUrl.slice(0, 50)}...</a>
                              {task.sourceImageUrls?.length > 0 && ` + ${task.sourceImageUrls.length} ref(s)`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Processing — Live status cards */}
                {galleryTab === "processing" && (
                  galleryProcessing.length === 0 ? (
                    <div className="empty-state"><div className="emoji">⏳</div><div className="msg">No generations currently processing.</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryProcessing.map(task => (
                        <div key={task.id} className="task-card">
                          <div className="task-header">
                            <span className="task-model">{task.modelName}{task.batchImageIndex && task.requestedImages > 1 && <span className="task-batch-index">{task.batchImageIndex}/{task.requestedImages}</span>}</span>
                            <span className={`task-status ${task.status}`}>{task.status.toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0" }}>{task.prompt?.slice(0, 80)}</div>
                          <div className="task-timer">{formatTime(task.wallClockMs || (Date.now() - task.startTime))}</div>
                          <div className="task-progress"><div className="task-progress-fill" style={{ width: `${Math.min(95, ((Date.now() - task.startTime) / PROGRESS_BAR_MS) * 100)}%` }} /></div>
                          <div style={{ marginTop: 8 }}>
                            <button className="result-action-btn" onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Failed — Full debug info */}
                {galleryTab === "failed" && (
                  galleryFailed.length === 0 ? (
                    <div className="empty-state"><div className="emoji">✓</div><div className="msg">No failed generations. Looking good!</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryFailed.map(task => (
                        <div key={task.id} className={`task-card${selectMode ? " selecting-card" : ""}${selectMode && selectedIds.has(task.id) ? " card-selected" : ""}`}
                          onClick={selectMode ? () => toggleSelect(task.id) : undefined}
                          style={{ borderColor: "rgba(239,68,68,0.2)", ...(selectMode ? { cursor: "pointer", position: "relative" } : {}) }}>
                          {selectMode && <div aria-hidden="true" className={`select-check${selectedIds.has(task.id) ? " on" : ""}`}>{selectedIds.has(task.id) ? "✓" : ""}</div>}
                          <div className="task-header">
                            <span className="task-model">{task.modelName}{task.batchImageIndex && task.requestedImages > 1 && <span className="task-batch-index">{task.batchImageIndex}/{task.requestedImages}</span>}</span>
                            <span className="task-status failed">FAILED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--error)", margin: "6px 0", fontFamily: font, background: "rgba(239,68,68,0.08)", padding: "8px 10px", borderRadius: 6, wordBreak: "break-word" }}>
                            {task.error || "Unknown error"}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6, fontFamily: font }}>
                            <div><strong>Model ID:</strong> {task.modelId}</div>
                            <div><strong>Provider:</strong> {task.provider}</div>
                            <div><strong>Gen Type:</strong> {task.genType || "unknown"}</div>
                            <div><strong>Resolution:</strong> {task.resolution || "default"}</div>
                            <div><strong>Duration:</strong> {task.duration || "N/A"}</div>
                            <div><strong>Seed:</strong> {task.seed || "-1"}</div>
                            <div><strong>Aspect:</strong> {task.aspectRatio || "auto"}</div>
                            <div><strong>Prompt:</strong> <span style={{ color: "var(--text-secondary)" }}>{task.prompt?.slice(0, 120)}</span></div>
                            <div><strong>Time:</strong> {task.startTime ? formatTimestamp(task.startTime) : "unknown"}</div>
                          </div>
                          {!selectMode && (
                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button className="result-action-btn" style={{ color: "var(--accent)" }} onClick={() => regenerateTask(task)}>🔄 Retry</button>
                            <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(JSON.stringify({ modelId: task.modelId, error: task.error, prompt: task.prompt, resolution: task.resolution, duration: task.duration, seed: task.seed, genType: task.genType }, null, 2)); }}>📋 Copy Debug</button>
                          </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              );
            })()}

            {/* ═══ LOGS ═══ */}
            {page === "logs" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Generation Log ({logs.length} entries)</h2>
                {logs.length === 0 ? (
                  <div className="empty-state"><div className="emoji">📋</div><div className="msg">Your generation history will appear here. Each entry can be replayed with one click.</div></div>
                ) : (
                  <>
                    {renderLogSelectBar()}
                    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                      <div className="log-row log-header" style={logSelectMode ? { paddingLeft: 40 } : undefined}>
                        <span className="log-hide-m">Time</span><span>Prompt</span><span>Models</span><span>Type</span><span className="log-hide-m">Cost</span><span className="log-hide-m"></span>
                      </div>
                      {logs.map(log => {
                        const sel = logSelectMode && logSelectedIds.has(log.id);
                        return (
                          <div key={log.id} className={`log-row${sel ? " log-row-selected" : ""}`}
                            onClick={logSelectMode ? () => toggleSelectLog(log.id) : () => replayLog(log)}
                            style={logSelectMode ? { position: "relative", paddingLeft: 40 } : undefined}>
                            {logSelectMode && <div aria-hidden="true" className={`select-check log-check${sel ? " on" : ""}`}>{sel ? "✓" : ""}</div>}
                            <span className="log-hide-m" style={{ fontFamily: font, fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(log.timestamp)}</span>
                            <span className="log-prompt">{log.prompt}</span>
                            <span className="log-models">{logModelsLabel(log)}</span>
                            <span style={{ fontSize: 11 }}>{TYPE_ICONS[log.genType]}</span>
                            <span className="log-cost log-hide-m">{formatCost(log.totalCost)}</span>
                            {logSelectMode
                              ? <span className="log-hide-m" />
                              : <button className="log-replay log-hide-m" onClick={e => { e.stopPropagation(); replayLog(log); }}>▶</button>}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ═══ SETTINGS ═══ */}
            {page === "settings" && (
              <div style={{ maxWidth: 500 }}>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 24, color: "var(--text-secondary)" }}>Settings</h2>

                {/* Appearance */}
                <div className="setting-group">
                  <div className="setting-label">Appearance</div>
                  <div className="setting-hint" style={{ marginBottom: 12 }}>Theme and animated backdrop are synced to the cloud — they follow you to every device.</div>

                  {/* Theme picker — color swatches */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Color Theme</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                      {Object.entries(THEMES).map(([key, t]) => (
                        <button key={key} onClick={() => setTheme(key)}
                          style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                            background: theme === key ? "rgba(99,102,241,0.15)" : "rgba(8,12,25,0.4)",
                            border: `1px solid ${theme === key ? t.accent : "var(--glass-border)"}`,
                            borderRadius: 10, cursor: "pointer", transition: "all 0.2s",
                            boxShadow: theme === key ? `0 0 16px ${t.accent}40` : "none",
                          }}>
                          <div style={{ width: 18, height: 18, borderRadius: "50%", background: t.accent, boxShadow: `0 0 8px ${t.accent}80`, flexShrink: 0 }} />
                          <div style={{ fontSize: 12, color: "var(--text-primary)", fontFamily: fontBody, fontWeight: theme === key ? 600 : 500, textAlign: "left" }}>{t.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Background picker */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Animated Background</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
                      {BACKGROUNDS.map(bg => {
                        const labels = { orbs: "◉ Orbs", stars: "✦ Stars", matrix: "⎔ Matrix", grid: "▦ Grid", none: "— None" };
                        return (
                          <button key={bg} onClick={() => setBackground(bg)}
                            style={{
                              padding: "10px 8px",
                              background: background === bg ? "rgba(99,102,241,0.15)" : "rgba(8,12,25,0.4)",
                              border: `1px solid ${background === bg ? "var(--accent)" : "var(--glass-border)"}`,
                              borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: font,
                              color: background === bg ? "var(--accent)" : "var(--text-secondary)",
                              fontWeight: background === bg ? 700 : 500, textAlign: "center",
                              transition: "all 0.2s", textTransform: "capitalize",
                            }}>{labels[bg] || bg}</button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Light mode toggle */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>Light Mode</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font, marginTop: 2 }}>Flip to a bright palette. Accent color stays.</div>
                    </div>
                    <button onClick={() => setLightMode(!lightMode)}
                      style={{
                        width: 48, height: 26, borderRadius: 14,
                        background: lightMode ? "var(--accent)" : "rgba(30,41,59,0.5)",
                        border: "1px solid var(--glass-border)", cursor: "pointer", position: "relative",
                        transition: "background 0.25s",
                      }}>
                      <div style={{ position: "absolute", top: 2, left: lightMode ? 24 : 2, width: 20, height: 20, borderRadius: "50%", background: "white", transition: "left 0.25s", boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }} />
                    </button>
                  </div>
                </div>

                {/* Cloud storage usage (per-generation manual backup via buttons on each result) */}
                <div className="setting-group">
                  <div className="setting-label">Cloud Storage</div>
                  <div className="setting-hint" style={{ marginBottom: 10 }}>
                    WaveSpeed output URLs expire after ~24h. To make a generation permanent, tap the <b>☁</b> button on that result card to back it up to cloud storage.
                  </div>
                  <div style={{ padding: "10px 14px", background: "rgba(8,12,25,0.3)", border: "1px solid var(--glass-border)", borderRadius: 10, fontSize: 11, color: "var(--text-secondary)", fontFamily: font, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>☁ {archiveStats.count} file{archiveStats.count === 1 ? "" : "s"} · {(archiveStats.bytes / 1024 / 1024).toFixed(1)} MB backed up</span>
                    <button onClick={async () => { const s = await getArchiveStats(); setArchiveStats(s); }}
                      style={{ padding: "4px 10px", fontSize: 10, background: "rgba(99,102,241,0.1)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font, fontWeight: 600 }}>Refresh</button>
                  </div>
                </div>

                {/* Account */}
                <div className="setting-group">
                  <div className="setting-label">Account</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>
                        {(() => { try { return localStorage.getItem("proximaai-user") || "anonymous"; } catch { return "anonymous"; } })()}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font, marginTop: 2 }}>Signed in · Cloud sync active</div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setShowAccountModal(true)}
                        style={{ padding: "8px 14px", background: "rgba(99,102,241,0.1)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, fontFamily: font, fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                        Manage
                      </button>
                      <button onClick={handleLogout}
                        style={{ padding: "8px 14px", background: "rgba(239,68,68,0.1)", color: "var(--error)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontFamily: font, fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                        Sign Out
                      </button>
                    </div>
                  </div>
                  {accountToast && (
                    <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, fontSize: 12, color: "var(--success)", fontFamily: font }}>
                      ✓ {accountToast}
                    </div>
                  )}
                </div>

                <div className="setting-group">
                  <div className="setting-label">WaveSpeed API Key</div>
                  {/* Masked text field, not type=password: Chrome would otherwise offer to save the API key in its password manager. */}
                  <input id="settings-wavespeed-key" type="text" className="setting-input" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    style={maskedCodeStyle(false)} aria-label="WaveSpeed API key"
                    placeholder={keyStatus === "ok" ? "Saved on the server — paste a new key to replace it" : "Paste your WaveSpeed API key..."}
                    value={keyInput} onChange={e => { setKeyInput(e.target.value); setTestStatus(null); }} />
                  <div className="setting-hint">Get your key at <span style={{ color: "var(--accent)" }}>wavespeed.ai/settings</span>. It is saved to ProximaAI's protected server store, never kept in this browser, and added to each request by ProximaAI's server.{keyStatus === "ok" ? " ✓ A working key is saved." : keyStatus === "missing" ? " No key saved yet." : keyStatus === "invalid" ? " ✗ WaveSpeed rejects the saved key." : ""}</div>
                  <button className="api-test-btn"
                    disabled={testStatus === "testing"}
                    onClick={async () => {
                      setTestStatus("testing");
                      try {
                        const typed = keyInput.trim();
                        if (typed) { await saveWavespeedKey(typed); setKeyInput(""); refreshProviderKeys(); pollUntracked(); }
                        const r = await refreshBalance();
                        const saved = typed ? "Saved. " : "";
                        if (r.keyStatus === "ok") setTestStatus({ ok: true, msg: `${saved}Connected! Balance: $${Number(r.balance).toFixed(4)}` });
                        else if (r.keyStatus === "missing") setTestStatus({ ok: false, msg: "No key saved on the server yet — paste it above." });
                        else if (r.keyStatus === "invalid") setTestStatus({ ok: false, msg: `${saved}WaveSpeed rejected this key. Check it and save again.` });
                        else setTestStatus({ ok: false, msg: `${saved}${r.error || "Could not reach WaveSpeed."}` });
                      } catch (err) {
                        setTestStatus({ ok: false, msg: err.message || "Could not save the key" });
                      }
                    }}>
                    {testStatus === "testing" ? "Checking..." : keyInput.trim() ? "Save & Test Key" : "Test Connection"}
                  </button>
                  {testStatus && testStatus !== "testing" && (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12,
                      fontFamily: font, fontWeight: 500,
                      background: testStatus.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${testStatus.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: testStatus.ok ? "var(--success)" : "var(--error)"
                    }}>
                      {testStatus.ok ? "✓ " : "✗ "}{testStatus.msg}
                    </div>
                  )}
                  {testStatus === "testing" && (
                    <div className="pulse" style={{ marginTop: 10, fontSize: 12, color: "var(--accent)", fontFamily: font }}>
                      ⏳ Contacting WaveSpeed API...
                    </div>
                  )}
                  {balance !== null && testStatus !== "testing" && !testStatus && <div style={{ marginTop: 8, fontFamily: font, fontSize: 13, color: "var(--success)" }}>Balance: ${Number(balance).toFixed(4)}</div>}
                </div>

                {/* kie.ai key (docs/SECOND-ACCOUNT-PLAN.md K1): encrypted in the server's Vault; with one saved, kie.ai's models
                    appear in the model list. The box never shows the key, only the masked fingerprint the server returns. */}
                <div className="setting-group">
                  <div className="setting-label">kie.ai API Key</div>
                  <input id="settings-kie-key" type="text" className="setting-input" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    style={maskedCodeStyle(false)} aria-label="kie.ai API key"
                    placeholder={kieFingerprint ? `Saved (${kieFingerprint}) — paste a new key to replace it` : hasKieKey ? "Saved on the server — paste a new key to replace it" : "Paste your kie.ai API key..."}
                    value={kieKeyInput} onChange={e => { setKieKeyInput(e.target.value); setKieTestStatus(null); }} />
                  <div className="setting-hint">Get your key from your <span style={{ color: "var(--accent)" }}>kie.ai</span> account (API Key page). It is saved encrypted on ProximaAI's server, never kept in this browser, and only this account can use it. With a key saved, the kie.ai models appear in the model list.</div>
                  <div style={{ display: "grid", gridTemplateColumns: hasKieKey ? "1fr 1fr" : "1fr", gap: 8 }}>
                    <button className="api-test-btn" disabled={kieTestStatus === "testing"}
                      onClick={async () => {
                        setKieTestStatus("testing");
                        try {
                          const typed = kieKeyInput.trim();
                          if (typed) { await saveProviderKey("kie", typed); setKieKeyInput(""); await refreshProviderKeys(); }
                          const r = await checkKieBalance();
                          const saved = typed ? "Saved. " : "";
                          if (r.keyStatus === "ok") { setKieKeyStatus("ok"); pollUntracked(); }
                          if (r.keyStatus === "invalid") setKieKeyStatus("invalid");
                          if (r.keyStatus === "ok") setKieTestStatus({ ok: true, msg: `${saved}Connected! ${r.credits} credits (about $${(r.credits * KIE_CREDIT_USD).toFixed(2)})` });
                          else if (r.keyStatus === "missing") setKieTestStatus({ ok: false, msg: "No kie.ai key saved yet — paste it above." });
                          else if (r.keyStatus === "invalid") setKieTestStatus({ ok: false, msg: `${saved}kie.ai rejected this key. Check it and save again.` });
                          else setKieTestStatus({ ok: false, msg: `${saved}${r.error || "Could not reach kie.ai."}` });
                        } catch (err) {
                          setKieTestStatus({ ok: false, msg: err.message || "Could not save the key" });
                        }
                      }}>
                      {kieTestStatus === "testing" ? "Checking..." : kieKeyInput.trim() ? "Save & Test Key" : "Test Connection"}
                    </button>
                    {hasKieKey && (
                      <button className="api-test-btn" disabled={kieTestStatus === "testing"}
                        onClick={async () => {
                          if (!window.confirm("Remove the saved kie.ai key? kie.ai models disappear from the list until a key is saved again.")) return;
                          setKieTestStatus("testing");
                          try {
                            await clearProviderKey("kie");
                            await refreshProviderKeys();
                            setKieTestStatus({ ok: true, msg: "Removed." });
                          } catch (err) {
                            setKieTestStatus({ ok: false, msg: err.message || "Could not remove the key" });
                          }
                        }}>
                        Remove Key
                      </button>
                    )}
                  </div>
                  {kieTestStatus && kieTestStatus !== "testing" && (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12,
                      fontFamily: font, fontWeight: 500,
                      background: kieTestStatus.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${kieTestStatus.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: kieTestStatus.ok ? "var(--success)" : "var(--error)"
                    }}>
                      {kieTestStatus.ok ? "✓ " : "✗ "}{kieTestStatus.msg}
                    </div>
                  )}
                  {kieTestStatus === "testing" && (
                    <div className="pulse" style={{ marginTop: 10, fontSize: 12, color: "var(--accent)", fontFamily: font }}>
                      ⏳ Contacting kie.ai...
                    </div>
                  )}
                  {hasKieKey && kieKeyStatus === "invalid" && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "var(--error)", fontFamily: font }}>kie.ai rejected the saved key. Paste a working one and press Save &amp; Test; running kie.ai generations then resume.</div>
                  )}
                  {/* S3 review #11: kie.ai generations still running stop polling without a key; saving one resumes them. */}
                  {!hasKieKey && (() => {
                    const waiting = tasks.filter(t => isInFlight(t) && isKieGeneration(t)).length;
                    return waiting > 0 && <div style={{ marginTop: 8, fontSize: 12, color: "var(--amber)", fontFamily: font }}>{waiting} kie.ai generation{waiting > 1 ? "s are" : " is"} waiting for a kie.ai key.</div>;
                  })()}
                </div>

                {readBrowserAccount()?.role === "owner" && <InviteSection font={font} />}

                <div className="setting-group">
                  <div className="setting-label">Default Settings</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                    <div>
                      <label htmlFor="settings-image-res" style={{ fontSize: 11, color: "var(--text-muted)" }}>Image Resolution</label>
                      <select id="settings-image-res" className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultImageRes} onChange={e => { setDefaultImageRes(e.target.value); setSetting("defaultImageRes", e.target.value); trackedSync("defaultImageRes", () => syncSetting("defaultImageRes", e.target.value)).catch(() => {}); }}>
                        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="settings-video-dur" style={{ fontSize: 11, color: "var(--text-muted)" }}>Video Duration</label>
                      <select id="settings-video-dur" className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultVideoDur} onChange={e => { setDefaultVideoDur(Number(e.target.value)); setSetting("defaultVideoDur", e.target.value); trackedSync("defaultVideoDur", () => syncSetting("defaultVideoDur", e.target.value)).catch(() => {}); }}>
                        <option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">About</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--text-primary)" }}>ProximaAI</strong> — Parallel AI Generation Cockpit<br />
                    {Object.values(MODELS).flat().length} models registered across {Object.keys(MODELS).length} categories<br />
                    Powered by WaveSpeed.ai unified API
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">Storage</div>
                  {storageStats && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: font, lineHeight: 1.8, marginBottom: 10 }}>
                      <div>Saved Outputs: <strong style={{ color: "var(--text-primary)" }}>{storageStats.tasks}</strong></div>
                      <div>Generation Logs: <strong style={{ color: "var(--text-primary)" }}>{storageStats.history}</strong></div>
                      <div>Favorite Models: <strong style={{ color: "var(--text-primary)" }}>{favoriteModelCount}</strong></div>
                      {storageStats.usedMB && <div>Disk Usage: <strong style={{ color: "var(--text-primary)" }}>{storageStats.usedMB} MB</strong></div>}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      const ab = await readAutoBackups();
                      if (!confirm(`Clear all generation logs? (local + cloud)\n\n${backupNotice(ab, { what: "them" })}`)) return;
                      setSaveStatus("saving");
                      const bk = await createBackup("pre-clear-logs", "Before Clear Logs");
                      if (!bk?.ok) {
                        setSaveStatus("error");
                        setAccountToast(`Couldn't create the safety backup (${bk?.error || "unknown error"}) — nothing was deleted.`);
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // The clear's bound is the SERVER's time, read before anything changes (review round 12: the
                      // device's estimate, serverNow(), could sit past the server's time). No slack, unlike Clear
                      // Outputs / Reset: Clear Logs deletes no files and no WaveSpeed copies, so an entry created just
                      // before the snapshot that this device has not read yet may go with the rest.
                      // This device's History and its queued History uploads are copied BEFORE the snapshot (review round
                      // 13): only they are named, queued as intents and taken from the queue; an entry that arrives after
                      // the copy (another device's, or a generation started here meanwhile) stays. The copy covers every
                      // entry stored here, not only the 500 loaded (review round 14), read before the snapshot too.
                      // The cloud's History ids, read before the snapshot as Reset and Clear Outputs do (review round 16
                      // #6): the stash below holds every planned entry the cloud lacks. null (unreadable): every one.
                      const cloudLogIds = isSupabaseConfigured() ? ((await pullCloudIds())?.history ?? null) : null;
                      const storedLogs = await allStoredHistory();
                      const removedLogIds = [...new Set([...logsRef.current.map(l => l.id), ...storedLogs.map(l => l.id)])];
                      const queuedLogsAtSnap = peekQueuedUploads(["history"]);
                      const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now();
                      if (snap == null) {
                        setSaveStatus("error");
                        setAccountToast("Couldn't read the server's time — nothing was cleared. Try again.");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // No cleared entry may be uploaded again: queued uploads and this session's replays (review wf_1945b758-923 #1).
                      const clearedLogIds = [...new Set([...removedLogIds, ...queuedLogsAtSnap.map(e => e.id)])];
                      const clearedLogSet = new Set(clearedLogIds);
                      // The stash, stored BEFORE the take (review round 14): if this clear gets no answer and a restore voids
                      // it at a replay, the stash gives back the uploads it takes and every planned entry the cloud lacks
                      // (review round 16 #6: by the cloud read above, not savedLogIds, which means "stored here"). Dropped
                      // once the clear answers. Review round 15 S4: the uploads come from a fresh peek right before the take
                      // (nothing awaited from here to it: exactly the entries taken, a version re-queued during the server-time
                      // read included), and the entries stored here beyond the loaded ones (deleteHistoryEntries removes
                      // them too) are in it. Too big for localStorage: at least the loaded ones.
                      const stashUploads = peekQueuedUploads(["history"]).filter(e => clearedLogSet.has(e.id));
                      const logsStash = clearLogsStash({ loaded: logsRef.current, stored: storedLogs, uploads: stashUploads, planned: clearedLogSet, cloudLogIds });
                      // Reserve FIRST (task B12a): the clear's intents and (task B13a, review round 26 #4) its stash, the
                      // loaded-only one if the full one does not fit, before the take or any other change and before the
                      // clear fires (review wf_ec400a67-988 #1). No room for both: nothing changed, nothing to undo.
                      if (!reserveDelete({ intents: [{ kind: "history-delete", ids: clearedLogIds, at: snap }],
                        stash: { at: snap, value: logsStash.full, fallback: logsStash.loadedOnly } })) {
                        setSaveStatus("error");
                        setAccountToast(STORAGE_FULL_TOAST);
                        setTimeout(() => setAccountToast(""), 8000);
                        return;
                      }
                      const takenLogUploads = takeQueuedUploads("history", clearedLogIds);
                      for (const id of clearedLogIds) deletingLogIds.current.add(id);
                      setFailedSyncCount(getFailedSyncs().length);
                      // Kept for a voided clear's put-back: the current version of each removed entry and whether it was
                      // saved, plus the stored entries beyond the loaded ones.
                      const logsBefore = logsRef.current.filter(l => clearedLogSet.has(l.id));
                      const loadedBefore = new Set(logsBefore.map(l => l.id));
                      const storedOnlyBefore = storedLogs.filter(l => !loadedBefore.has(l.id));
                      const savedLogsBefore = new Set(clearedLogIds.filter(id => savedLogIds.current.has(id)));
                      setLogs(prev => prev.filter(l => !clearedLogSet.has(l.id)));
                      for (const id of clearedLogIds) savedLogIds.current.delete(id);
                      // Only the planned ids leave IndexedDB (review round 14): an entry that arrived after the copy stays
                      // there, untouched.
                      await deleteHistoryEntries(clearedLogIds);
                      // Restore-checked at its queue time (review round 8): a restore that landed meanwhile wins. In
                      // flight for every tab until its answer is handled (task B9, review round 22 #2; the finally ends it).
                      const logsFlight = beginDeleteFlight({ "history-delete": clearedLogIds }, snap);
                      try {
                      const cr = await clearQueuedRemote("history", snap, clearedLogIds);   // named: entries created later elsewhere stay (round 9)
                      if (cr.ok) dropClearStash(snap);   // confirmed: its stash goes (a void gives it back below, round 17)
                      if (cr.voided) {
                        voidDeleteIntents("history-delete", clearedLogIds, snap);
                        releaseVoided(deletingLogIds, "history-delete", clearedLogIds);
                        // The restore wins; nothing of this device is lost (review round 13): its entries and their queued
                        // uploads come back (an entry newer than the one put back wins). Task B7b (review round 20 #2/#6):
                        // only what the shared delete state lets come back (storage.js inlineVoidPutBack, stashGiveBack's
                        // rule): an entry pending deletion at another time joins this clear's stash for that time, one
                        // confirmed meanwhile stays gone, and the uploads pass the shared upload filter.
                        const back = inlineVoidPutBack(snap, { logs: [...logsBefore, ...storedOnlyBefore], uploads: takenLogUploads });
                        const backIds = new Set(back.logs.map(l => l.id));
                        const logsBack = logsBefore.filter(l => backIds.has(l.id));
                        // Task B13b (simulator I2): a stored-only entry given back that a page load would show (an earlier
                        // clear of this tab had just taken it out of state) goes back into state too, as loaded (saved).
                        const logsIntoView = intoLoadedView(storedOnlyBefore.filter(l => backIds.has(l.id)), [...logsRef.current, ...logsBack], { time: l => l.timestamp });
                        const logsToState = [...logsBack, ...logsIntoView];
                        setLogs(prev => { const have = new Set(prev.map(l => l.id)); const add = logsToState.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
                        for (const l of logsBack) { addHistoryEntry(l); if (savedLogsBefore.has(l.id)) savedLogIds.current.add(l.id); }
                        for (const l of logsIntoView) savedLogIds.current.add(l.id);
                        const loadedNow = new Set(logsRef.current.map(l => l.id));
                        for (const l of storedOnlyBefore) if (backIds.has(l.id) && !loadedNow.has(l.id)) addHistoryEntry(l);   // beyond the loaded ones
                        putBackQueuedUploads(back.uploads);
                        // Round 17 #1/#3: then the stash, with what an earlier clear's stash merged into it during the call,
                        // and every stash whose ids moved here (versions put back above win).
                        applyClearStashes(voidedClearStashes(snap), { logs: backIds });
                        setFailedSyncCount(getFailedSyncs().length);
                        setSaveStatus("idle");
                        setAccountToast("A restore on another device replaced your data while this clear waited — nothing was cleared in the cloud");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      const logsGone = cr.ok && await settleCloudClear({ history: clearedLogIds, at: snap });
                      getStorageStats().then(s => setStorageStats(s));
                      if (!logsGone) {
                        setSaveStatus("error");
                        setAccountToast("Logs cleared here — the cloud clear will finish on your next save or reload");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast(bk.id ? "Logs cleared — safety backup saved" : "Logs cleared permanently");
                      setTimeout(() => setAccountToast(""), 5000);
                      } finally { endDeleteFlight(logsFlight); }
                    }}>Clear Logs</button>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      const ab = await readAutoBackups();
                      if (!confirm(`Clear ALL generations? They are removed everywhere: this device, the cloud, WaveSpeed, their files and their History.\n\n${backupNotice(ab, { what: "them" })}`)) return;
                      setSaveStatus("saving");
                      // A backup the owner chose (switch on) must exist before anything is destroyed (review wf_9d0e3664-ab7 #1).
                      const bk = await createBackup("pre-clear-outputs", "Before Clear Outputs");
                      if (!bk?.ok) {
                        setSaveStatus("error");
                        setAccountToast(`Couldn't create the safety backup (${bk?.error || "unknown error"}) — nothing was deleted.`);
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // This device's tasks and History entries when the clear began, taken BEFORE the snapshot: the clear
                      // plans over them and the cloud rows existing by the snapshot only (review round 12: an entry or
                      // task another device synced in during the awaits below was created after the snapshot and must
                      // survive, rule g). This device's entries are never "late" below (they are what the owner sees and
                      // is clearing), so their History-only generations are planned and named (review round 11).
                      const localTasks = tasksRef.current.slice();
                      const localLogs = logsRef.current.slice();
                      const localLogIds = new Set(localLogs.map(l => l.id));
                      // The queued task uploads at the snapshot, read before it too (review round 13): an upload queued
                      // after it (a generation started meanwhile) is neither planned nor named nor taken from the queue.
                      const queuedAtSnap = peekQueuedUploads(["task"]);
                      // The clear covers the rows that existed before this read (review round 10): its bound is the
                      // SERVER's time now (review round 11: a stale device clock offset could put it after the server's
                      // time), less the slack second for rows whose write began just before and is not visible to the
                      // read yet. Every row inside it is read and purged; later ones stay.
                      const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now();
                      if (snap == null) {
                        setSaveStatus("error");
                        setAccountToast("Couldn't read the server's time — nothing was cleared. Try again.");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      const clearAt = snap - SNAPSHOT_SLACK_MS;
                      // Every generation this account had at the snapshot: this device's state captured above and every
                      // cloud row existing by it (all pages, any status), so the purge reaches rows beyond the 500 loaded.
                      // A failed read clears nothing (review wf_ec400a67-988 #3).
                      const remote = isSupabaseConfigured() ? await pullAllForPurge() : { tasks: [], history: [] };
                      if (!remote) {
                        setSaveStatus("error");
                        setAccountToast("Couldn't read every generation from the cloud — nothing was cleared. Try again.");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // Rows created after the snapshot belong to generations another device started after it: left
                      // alone here and in the cloud (review round 12), unless this device already held that generation
                      // at the snapshot (its task, an item of its History, or a queued upload): such a row is one this
                      // device's generation wrote late, and it goes too (review round 13).
                      const copyTasks = new Map(localTasks.map(t => [t.id, t]));
                      const queuedTasks = new Map(queuedAtSnap.map(e => [e.id, e.data]));
                      const remoteTasks = new Map(remote.tasks.map(t => [t.id, t]));
                      const heldIds = new Set([...copyTasks.keys(), ...queuedTasks.keys(),
                        ...localLogs.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : []).map(i => i?.id))].filter(Boolean));
                      const plannedIds = new Set([...copyTasks.keys(), ...queuedTasks.keys()]);
                      for (const t of remote.tasks) if (!(Date.parse(t.createdAt) > clearAt) || heldIds.has(t.id)) plannedIds.add(t.id);
                      // Each planned generation is purged from its CURRENT version (review round 13): a WaveSpeed id or an
                      // archive path that arrived during the awaits above is purged too.
                      const currentTasks = new Map(tasksRef.current.map(t => [t.id, t]));
                      const all = new Map();
                      for (const id of plannedIds) all.set(id, currentTasks.get(id) || remoteTasks.get(id) || queuedTasks.get(id) || copyTasks.get(id) || { id });
                      const realTasks = [...all.values()];
                      // Generations History holds without a tasks row (a restore keeps 500 tasks rows but up to 1000
                      // entries) go too, with their files (review round 7). Cloud-only entries created after the snapshot
                      // belong to generations started after it on another device: left alone (review round 10). Only the
                      // cloud list is filtered: this device's own entries are never late (review round 11), or they
                      // stayed here and their History-only items survived.
                      const late = new Set(remote.history.filter(l => !localLogIds.has(l.id) && Date.parse(l.createdAt) > clearAt).map(l => l.id));
                      const mergedLogs = mergeLogs(localLogs, remote.history.filter(l => !late.has(l.id)));
                      // A generation with any row in the read (a late one included) is not History-only: a post-snapshot
                      // row must not get a History-only intent that a replay would turn into a delete (review round 12).
                      const historyOnly = historyOnlyGenerations(mergedLogs, new Set([...all.keys(), ...remote.tasks.map(t => t.id)]));
                      // A History-only generation whose task reached this device during the awaits is purged from that
                      // current version too (its WaveSpeed id, its files).
                      const removed = [...realTasks, ...historyOnly.map(g => currentTasks.has(g.id) ? { ...g, ...currentTasks.get(g.id) } : g)];
                      const clearedTaskIds = removed.map(t => t.id);
                      const plannedTaskIds = new Set(clearedTaskIds);
                      // Reserve FIRST (task B12a, review round 25 #1): the purge is planned (nothing changes; queued before the
                      // clears, every generation goes, so no item is outstanding, review #4; planned over the cloud's History too,
                      // so entries beyond the loaded ones go with their files, review round 2; the clear strips History
                      // server-side), then the clear's task intents, the History intents it plans and the hold of its files and
                      // WaveSpeed ids are written together, before anything below changes and before the clear fires (review
                      // wf_ec400a67-988 #1; review round 23 #3: the held items never see their owners without an intent). No room
                      // (a full localStorage): nothing was written or changed, so the clear stops here with nothing to undo.
                      // Task B13b (simulator classes B and D): what this clear does NOT delete is kept for the plan: the late
                      // rows (created after the bound on another device, not held here) and the late cloud-only entries with
                      // their items. Before, it planned with nothing kept, so a late row's files (an item of an entry it
                      // removes, a shared batch input) were held for a generation this clear never deletes: they waited for
                      // good, or were deleted under a generation that lives on.
                      const lateKept = [...remote.tasks.filter(t => !plannedTaskIds.has(t.id)), ...entriesWithout(remote.history.filter(l => late.has(l.id)), plannedTaskIds)];
                      const staged = planStagePurge(removed, lateKept, { all: true, logs: mergedLogs, serverHistory: true, at: clearAt, holdAt: clearAt });
                      // The stash (review round 14): if this clear gets no answer and a restore voids it at a replay, it
                      // gives back the queued uploads this clear takes (task uploads here, History ones in stagePurge) and
                      // the planned tasks / History entries this device holds that the cloud read did not. Dropped once the
                      // clear answers or its intents are all confirmed. Task B13a (review round 26 #4): written INSIDE the
                      // reservation below (nothing awaited from here to the take).
                      // Kept for a voided clear's put-back too (review rounds 13, 14): the History entries stagePurge
                      // removes here, as their CURRENT versions read right before it (no await between: never the
                      // pre-snapshot copy, so an entry this device no longer holds is not put back).
                      const logsBefore = new Map(logsRef.current.map(l => [l.id, l]));
                      const mergedLogIds = new Set(mergedLogs.map(l => l.id));
                      const outputsStash = buildClearStash({
                        uploads: peekQueuedUploads(["task", "history"]).filter(e => (e.kind === "task" ? plannedTaskIds : mergedLogIds).has(e.id)),
                        tasks: realTasks.filter(t => currentTasks.has(t.id) || copyTasks.has(t.id)),
                        logs: [...logsBefore.values()].filter(l => mergedLogIds.has(l.id)),
                        cloudTaskIds: new Set(remoteTasks.keys()), cloudLogIds: new Set(remote.history.map(l => l.id)) });
                      // Task B13a (review round 26 #4): the stash is part of the reservation; if it does not fit with the
                      // intents and the hold, the clear stops with the storage-full message and nothing changed.
                      if (!reserveDelete({ intents: [{ kind: "task-delete", ids: clearedTaskIds, at: clearAt }, ...staged.intents], holdAt: clearAt, hold: staged.hold,
                        stash: { at: clearAt, value: outputsStash } })) {
                        setSaveStatus("error");
                        setAccountToast(STORAGE_FULL_TOAST);
                        setTimeout(() => setAccountToast(""), 8000);
                        return;
                      }
                      const queuedAt = clearAt;
                      // Nothing removed may be uploaded again: the debounced queue, queued uploads (a failed upload left no
                      // tombstone to stop it) and this session's later replays (review wf_1945b758-923 #1). Only the planned
                      // ids leave the queues (review round 13): an upload queued after the snapshot stays.
                      taskSyncQueueRef.current = taskSyncQueueRef.current.filter(t => !plannedTaskIds.has(t.id));
                      if (!taskSyncQueueRef.current.length && taskSyncTimerRef.current) { clearTimeout(taskSyncTimerRef.current); taskSyncTimerRef.current = null; }
                      const takenUploads = takeQueuedUploads("task", clearedTaskIds);   // put back if a restore voids the clear
                      for (const id of clearedTaskIds) deletingIds.current.add(id);
                      const claimsBefore = claimantRecords(realTasks.map(t => t.id));   // put back if a restore voids the clear (round 9)
                      releasePredictions(realTasks.map(t => t.taskId)); recordClaimants(realTasks, { deleted: true });
                      // Whether each removed entry was saved, and their queued uploads (put back with logsBefore).
                      const savedLogsBefore = new Set(savedLogIds.current);
                      const logUploadsBefore = peekQueuedUploads(["history"]);
                      const plan = stagePurge(staged);   // the History changes planned above (the clear strips History server-side)
                      // Task B7a: the entries dropped here without a History intent of their own stay "being deleted" here
                      // while the clear's intents (queued at clearAt) are pending.
                      holdDeleting("history-delete", plan.localRemove, clearAt);
                      // Rows, plus the History-only generations this device's own entries hold (review round 11): the
                      // server tombstones History-only ids only of entries created by its bound, or named ones, and a
                      // local entry may be newer than the bound. Cloud-only entries' History-only generations are not
                      // named (a row that appeared for one after the read would be deleted unpurged); the server
                      // tombstones the ones still without a row itself (review round 10).
                      const rowIds = realTasks.map(t => t.id);
                      const namedHistoryOnly = historyOnly.filter(g => localLogIds.has(g.batchId)).map(g => g.id);
                      const namedIds = [...rowIds, ...namedHistoryOnly];
                      setFailedSyncCount(getFailedSyncs().length);
                      // Only the planned ids leave this device (review round 12): a task that arrived after the snapshot
                      // stays here, as it does in the cloud. What leaves is kept for a voided clear's put-back.
                      const tasksRemovedHere = tasksRef.current.filter(t => plannedTaskIds.has(t.id));
                      const savedTasksBefore = new Set(tasksRemovedHere.filter(t => savedTaskIds.current.has(t.id)).map(t => t.id));
                      setTasks(prev => prev.filter(t => !plannedTaskIds.has(t.id)));
                      deleteTasks([...plannedTaskIds]);
                      for (const id of plannedTaskIds) savedTaskIds.current.delete(id);
                      // Restore-checked at the clear's snapshot time (review rounds 8 and 10), in one transaction: the rows
                      // that existed then plus every row id this device knew (a row created later on another device
                      // stays). The server gives every generation without a row that History entries existing by then hold
                      // a user tombstone, and strips their History items in the same transaction (review rounds 7, 9, 10).
                      // In flight for every tab until its answer is handled (task B9, review round 22 #2; the finally
                      // ends it): the clear's task ids and the History entries it removes at its time.
                      const outputsFlight = beginDeleteFlight({ "task-delete": clearedTaskIds, "history-delete": plan.remove || [] }, clearAt);
                      try {
                      const cr = await clearQueuedRemote("task", queuedAt, namedIds);
                      // Archives that finished while this clear held their tasks (round 15 S5): re-applied if voided, their
                      // files deleted if confirmed.
                      // A void gives the stash back below (round 17: with what moved into it, and its followers).
                      const heldArchives = cr.ok ? (readClearStash(clearAt)?.archives || {}) : {};
                      if (cr.ok) dropClearStash(clearAt);   // confirmed: its stash goes
                      if (cr.voided) {
                        // A restore on another device landed after this clear was queued: it wins, nothing is purged.
                        voidDeleteIntents("task-delete", clearedTaskIds, clearAt);
                        releaseVoided(deletingIds, "task-delete", clearedTaskIds);
                        putBackClaimants(realTasks.map(t => t.id), claimsBefore);
                        for (const l of plan.rewrite || []) removeFailedSync("history", l.id);
                        voidDeleteIntents("history-delete", plan.remove || [], clearAt);
                        releaseVoided(deletingLogIds, "history-delete", plan.localRemove);
                        // The restore wins; nothing of this device is lost (review round 13): the tasks, History entries
                        // and queued uploads this clear removed here come back (a newer queued entry wins). Task B7b
                        // (review round 20 #2/#6): only what the shared delete state lets come back (storage.js
                        // inlineVoidPutBack, stashGiveBack's rule): an id pending deletion at another time joins this
                        // clear's stash for that time, one confirmed meanwhile stays gone, uploads pass the upload filter.
                        const localRemoved = new Set(plan.localRemove || []);
                        const back = inlineVoidPutBack(clearAt, { tasks: tasksRemovedHere,
                          logs: [...localRemoved].map(id => logsBefore.get(id)).filter(Boolean),
                          uploads: [...takenUploads, ...logUploadsBefore.filter(e => localRemoved.has(e.id) && logsBefore.has(e.id))] });
                        const backTaskIds = new Set(back.tasks.map(t => t.id));
                        const tasksBack = tasksRemovedHere.filter(t => backTaskIds.has(t.id));
                        setTasks(prev => { const have = new Set(prev.map(t => t.id)); const add = tasksBack.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
                        saveTasks(tasksBack);
                        for (const id of savedTasksBefore) if (backTaskIds.has(id)) savedTaskIds.current.add(id);
                        const logsBack = back.logs;
                        const backIds = new Set(logsBack.map(l => l.id));
                        setLogs(prev => { const have = new Set(prev.map(l => l.id)); const add = logsBack.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
                        for (const l of logsBack) { addHistoryEntry(l); if (savedLogsBefore.has(l.id)) savedLogIds.current.add(l.id); }
                        putBackQueuedUploads(back.uploads);
                        // Its holds wait for the next pass after the restore (owner ruling 2026-10-23; no keepGivenBack).
                        applyRelinks(tasksBack);   // task B13a (round 26 #6): relinks already ready, linked now
                        // Then the stash (round 17 #1/#3): what an earlier clear's stash merged into it during the call and
                        // every stash whose ids moved here come back too, and its archives re-apply (round 15 S5) onto
                        // the versions put back above, which win.
                        applyClearStashes(voidedClearStashes(clearAt), { tasks: new Map(tasksBack.map(t => [t.id, t])), logs: backIds });
                        setFailedSyncCount(getFailedSyncs().length);
                        setSaveStatus("idle");
                        setAccountToast("A restore on another device replaced your data while this clear waited — nothing was cleared in the cloud");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // Not answered: the intents stay queued and replay (Save, reload); nothing is purged before the rows go.
                      // History-only intents not named (cloud-only entries'): the server tombstoned the ones still without a
                      // row; one that has a row now is a generation another device just made, left alone (review round
                      // 10). The named ones are settled with the rows below.
                      // Confirmed through the one confirm helper (round 19 #3): they leave every stash too, so a kept part cannot bring them back.
                      // Task B13a (review round 26 #2): only the ids whose tasks row the server LEFT IN PLACE are assumed.
                      // Right after the clear, one scoped read says which of them have a row now: those are the server's own
                      // decision (rule g: it left that row alone), recorded as ASSUMED (no final mark; markAssumedConfirms
                      // too, for a tab on the previous build), so a row of one is released, never deleted again. Every other
                      // one had no row the server could leave alone (it tombstoned it, or, its entry already gone, a late
                      // upload is still to come): confirmed normally (final mark), so a row that shows up later is deleted
                      // again by the F1 rule. Before, every unnamed id was assumed, so a late row of a cleared generation
                      // lived on with its files already deleted (I1 + I6).
                      // A failed read marks them ALL assumed (as before B13a): the safe side. A wrong "assumed" can leave a
                      // cleared generation alive (visible; the owner can delete it again); a wrong normal confirm deletes,
                      // later and silently, a generation's row the server kept on purpose (rule g), with nothing to bring
                      // it back and no purge of its files or result. Never deleting what the owner did not delete wins.
                      const unnamedHistoryOnly = historyOnly.filter(g => !localLogIds.has(g.batchId)).map(g => g.id);
                      if (cr.ok && unnamedHistoryOnly.length) {
                        // Task B14 (review round 27 #2): a failed read is retried (a frozen tab or a killed socket resumes)
                        // before the all-assumed fallback below, which would release the files of a generation whose row
                        // is still to come.
                        let withRow = isSupabaseConfigured() ? null : new Set();
                        for (let i = 0; i < 3 && withRow === null; i++) {
                          if (i) await new Promise(r => setTimeout(r, 2000));
                          withRow = await taskRowsPresentRemote(unnamedHistoryOnly);
                        }
                        const assumedIds = withRow ? unnamedHistoryOnly.filter(id => withRow.has(id)) : unnamedHistoryOnly;
                        const assumedSet = new Set(assumedIds);
                        if (assumedIds.length) { markAssumedConfirms("task-delete", assumedIds, queuedAt); confirmIntents("task-delete", assumedIds, queuedAt, { assumed: true }); }
                        const plainIds = unnamedHistoryOnly.filter(id => !assumedSet.has(id));
                        // Task B13b (simulator class E): the server tombstones a History-only id only through a live entry
                        // holding it at the clear (its orphan rule); a Clear Logs pressed just before had already deleted the
                        // cloud-only entry, so the id got no tombstone and its late row upload was accepted (I1 until F1
                        // deleted it again, with its files already gone). These ids had no row the server could leave alone:
                        // they are NAMED now, at the clear's queue time (delete_queued_rows, restore-checked like a replay of
                        // their intents, which are still pending): since migration 20261023500000 every named id without a
                        // row gets a user tombstone, so a late upload is refused; a row that landed since the read above is
                        // a late upload of a cleared generation and goes (F1 would delete it too). Before that migration the
                        // call changes nothing for a rowless id. Its answer does not change the confirm below (the clear
                        // itself was accepted; a restore since then supersedes it and the cloud decides, as before); a
                        // failed call leaves F1 as the safety net.
                        if (plainIds.length && isSupabaseConfigured()) { try { await deleteTasksRemote(plainIds, queuedAt); } catch {} }
                        if (plainIds.length) confirmIntents("task-delete", plainIds, queuedAt);
                      }
                      if (cr.ok) queueArchivedFileDeletes(stashArchivePaths({ archives: heldArchives }));   // round 15 S5
                      const { note: purgedNote } = cr.ok ? await purgeEverywhere(plan) : { note: "" };
                      const outputsGone = cr.ok && await settleCloudClear({ tasks: namedIds, at: queuedAt });
                      // Review round 23 #3: that confirm released the generations' held files and WaveSpeed copies: sent now.
                      const note = outputsGone ? await finishPurge(plan) : purgedNote;
                      getStorageStats().then(s => setStorageStats(s));
                      if (!outputsGone) {
                        setSaveStatus("error");
                        setAccountToast("Generations cleared here — the cloud clear will finish on your next save or reload");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast(bk.id ? `Generations cleared — safety backup saved${note}` : note ? `Generations cleared${note}` : "Generations cleared permanently, everywhere");
                      setTimeout(() => setAccountToast(""), 5000);
                      } finally { endDeleteFlight(outputsFlight); }
                    }}>Clear Outputs</button>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      const ab = await readAutoBackups();
                      if (!confirm(`Clear ALL data? This removes everything: this device, the cloud, WaveSpeed, all files and all History.\n\n${backupNotice(ab)}`)) return;
                      setSaveStatus("saving");
                      // A backup the owner chose (switch on) must exist before anything is destroyed (review wf_9d0e3664-ab7 #1).
                      try { await favoriteSyncChainRef.current; } catch {}
                      const bk = await createBackup("pre-reset", "Before Reset Everything");
                      if (!bk?.ok) {
                        setSaveStatus("error");
                        setAccountToast(`Couldn't create the safety backup (${bk?.error || "unknown error"}) — nothing was deleted.`);
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // The reset covers the rows that existed before this read (review round 10): its bound is the
                      // SERVER's time now (review round 11: a stale device clock offset could put it after the server's
                      // time), less the slack second for rows whose write began just before and is not visible to the
                      // read yet. Every row inside it is read and purged; later ones stay. Settings and favorites are
                      // bounded by the exact snapshot (below). This device's tasks and History are taken BEFORE the
                      // snapshot (review round 12): the reset plans, names and queues intents only for what existed by
                      // it; one another device synced in during the awaits below is not deleted in the cloud. The copy
                      // covers every task and History entry STORED here, not only the 500 loaded (review round 14), read
                      // before the snapshot too; a loaded version wins over its stored one.
                      const storedTasks = await allStoredTasks();
                      const storedLogs = await allStoredHistory();
                      const localTasks = tasksRef.current.slice();
                      const localLogs = logsRef.current.slice();
                      // The queued uploads at the snapshot, read before it too (review round 13): one queued after it (a
                      // generation started meanwhile) is neither planned nor named nor taken from the queue.
                      const queuedAtSnap = peekQueuedUploads(["task", "history"]);
                      const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now();
                      if (snap == null) {
                        setSaveStatus("error");
                        setAccountToast("Couldn't read the server's time — nothing was reset. Try again.");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      const resetAt = snap - SNAPSHOT_SLACK_MS;
                      // Everything this account has, here and every cloud row (all pages, any status): the purge needs it
                      // after the clear below. A failed read clears nothing (review wf_ec400a67-988 #3).
                      const remote = isSupabaseConfigured() ? await pullAllForPurge() : { tasks: [], history: [] };
                      if (!remote) {
                        setSaveStatus("error");
                        setAccountToast("Couldn't read every generation from the cloud — nothing was reset. Try again.");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      // Local favorites reset (not bounded by the snapshot). What it replaces is read here and kept (review
                      // round 14): the refs, the local setting and the queued favorites upload it removes; a voided reset puts
                      // them back. The reset itself happens only after the reservation below (task B12a).
                      const favoriteScope = getDeviceId();
                      const favoritesBefore = { byType: favoriteModelsRef.current, updatedAt: favoriteModelsUpdatedAtRef.current,
                        queued: getFailedSyncs().filter(e => e.kind === "model-favorites" && e.id === favoriteScope).map(e => ({ ...e })) };
                      favoritesBefore.setting = await getSetting(localModelFavoritesKey(favoriteScope));
                      // Review round 16 #5: a Reset pressed again while an earlier one is unsettled (the toast below asks
                      // for it) finds the favorites that reset emptied. What it replaces is then the earlier favoritesBefore
                      // (its setting, updatedAt and queued upload), carried in its stash and its voided branch alike.
                      Object.assign(favoritesBefore, chainedFavoritesBefore(favoritesBefore, favoriteScope));
                      // Cloud rows and History created after the snapshot belong to generations started after it: left
                      // alone (review rounds 10 and 12), unless this device already held that generation at the snapshot
                      // (its task, an item of its History or of a queued History upload, a queued task upload): such a
                      // row is one this device's generation wrote late, and it goes too (review round 13).
                      const copyTasks = new Map([...storedTasks, ...localTasks].map(t => [t.id, t]));
                      const queuedTasks = new Map(queuedAtSnap.filter(e => e.kind === "task").map(e => [e.id, e.data]));
                      const queuedLogs = new Map(queuedAtSnap.filter(e => e.kind === "history").map(e => [e.id, e.data]));
                      const remoteTasks = new Map(remote.tasks.map(t => [t.id, t]));
                      const copyLogs = new Map([...storedLogs, ...localLogs].map(l => [l.id, l]));
                      const heldIds = new Set([...copyTasks.keys(), ...queuedTasks.keys(),
                        ...[...copyLogs.values(), ...queuedLogs.values()].flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : []).map(i => i?.id))].filter(Boolean));
                      const plannedTaskIds = new Set([...copyTasks.keys(), ...queuedTasks.keys()]);
                      for (const t of remote.tasks) if (!(Date.parse(t.createdAt) > resetAt) || heldIds.has(t.id)) plannedTaskIds.add(t.id);
                      const plannedLogIds = new Set([...copyLogs.keys(), ...queuedLogs.keys()]);
                      for (const l of remote.history) if (!plannedLogIds.has(l.id) && !(Date.parse(l.createdAt) > resetAt)) plannedLogIds.add(l.id);
                      // Task B13c (simulator I6-end): the History-only generations of the entries this reset deletes (an item
                      // with no row anywhere: another device's row still to be uploaded) go with it, NAMED, as Clear Outputs'
                      // do. The server tombstones a rowless item only of entries created by the bound or a named one, and an
                      // entry this device holds is deleted whatever its age: the item stayed alive (its late row accepted)
                      // while this reset planned its files from the entry. Named, it is tombstoned in the reset's transaction
                      // (a late row is refused) and its files are planned from its item (historyOnlyGenerations).
                      const resetHistoryOnly = new Map(historyOnlyGenerations([...plannedLogIds].map(id => copyLogs.get(id) || queuedLogs.get(id) || remote.history.find(l => l.id === id)).filter(Boolean),
                        new Set([...plannedTaskIds, ...remoteTasks.keys()])).map(g => [g.id, g]));
                      for (const id of resetHistoryOnly.keys()) plannedTaskIds.add(id);
                      // No removed row may be uploaded again (review wf_1945b758-923 #1, as in Clear Outputs). Only the
                      // planned ids leave the queues (review round 13): an upload queued after the snapshot stays, and so
                      // does its generation, here and in the cloud (review round 14).
                      // Each planned generation and entry is purged from its CURRENT version (review round 13): a WaveSpeed
                      // id or an archive path that arrived during the awaits above is purged too.
                      const currentTasks = new Map(tasksRef.current.map(t => [t.id, t]));
                      const currentLogs = new Map(logsRef.current.map(l => [l.id, l]));
                      const remoteLogs = new Map(remote.history.map(l => [l.id, l]));
                      // The queued uploads of the planned ids: exactly what the take below removes (nothing awaited from here to it).
                      const queuedPlanned = peekQueuedUploads(["task", "history"]).filter(e => (e.kind === "task" ? plannedTaskIds : plannedLogIds).has(e.id));
                      const takenData = new Map(queuedPlanned.map(e => [`${e.kind}:${e.id}`, e.data]));
                      const allTasks = new Map(), allLogs = new Map();
                      for (const id of plannedTaskIds) allTasks.set(id, currentTasks.get(id) || remoteTasks.get(id) || takenData.get(`task:${id}`) || queuedTasks.get(id) || copyTasks.get(id) || resetHistoryOnly.get(id) || { id });
                      for (const id of plannedLogIds) allLogs.set(id, currentLogs.get(id) || remoteLogs.get(id) || takenData.get(`history:${id}`) || queuedLogs.get(id) || copyLogs.get(id) || { id });
                      const removedTasks = [...allTasks.values()], removedLogs = [...allLogs.values()];
                      const clearedTaskIds = [...plannedTaskIds];
                      const clearedLogIds = [...plannedLogIds];
                      // Their files stay. Task B13b (simulator classes B and D): with the late cloud rows and entries this reset
                      // does not delete (created after its bound on another device), so no path of theirs is held for it.
                      const keptTasks = [...tasksRef.current.filter(t => !plannedTaskIds.has(t.id)),
                        ...remote.tasks.filter(t => !plannedTaskIds.has(t.id) && !currentTasks.has(t.id)), ...entriesWithout(remote.history.filter(l => !plannedLogIds.has(l.id)), plannedTaskIds)];
                      // Reserve FIRST (task B12a, review round 25 #1/#9/#16): the purge is planned (nothing changes), then the
                      // reset's intents and the hold of its files and WaveSpeed ids (its outcome decides them) are written
                      // together, before anything below changes (favorites, the Generate form's models, the stash, the queues,
                      // state, IndexedDB) and before the clear fires (review wf_ec400a67-988 #1). No room (a full localStorage):
                      // nothing was written or changed, so the reset stops here with nothing to undo.
                      const staged = planStagePurge(removedTasks, keptTasks, { history: false, alsoLogs: removedLogs, holdAt: resetAt });
                      // The time the emptied favorites will carry (set below, after the reservation; the stash names it).
                      const resetFavoritesAt = Date.now();
                      // The stash (review round 14): if this reset gets no answer and a restore voids it at a replay, it
                      // gives back the queued uploads it takes and the planned tasks / History entries this device holds
                      // that the cloud read did not. Dropped once the reset answers or its intents are all confirmed. Task
                      // B13a (review round 26 #4): written INSIDE the reservation (nothing awaited from here to the take).
                      const resetStash = { ...buildClearStash({
                        uploads: queuedPlanned,
                        tasks: [...plannedTaskIds].map(id => currentTasks.get(id) || copyTasks.get(id)).filter(Boolean),
                        logs: [...plannedLogIds].map(id => currentLogs.get(id) || copyLogs.get(id)).filter(Boolean),
                        cloudTaskIds: new Set(remoteTasks.keys()), cloudLogIds: new Set(remoteLogs.keys()) }),
                        // The favorites state this reset replaced (review round 15 S3): a later void puts it back while the
                        // favorites are still the ones the reset wrote (resetAt = their updatedAt).
                        favorites: { scope: favoriteScope, byType: favoritesBefore.byType, updatedAt: favoritesBefore.updatedAt,
                          setting: favoritesBefore.setting ?? null, queued: favoritesBefore.queued, resetAt: resetFavoritesAt } };
                      if (!reserveDelete({ intents: [{ kind: "task-delete", ids: clearedTaskIds, at: resetAt }, { kind: "history-delete", ids: clearedLogIds, at: resetAt }],
                        holdAt: resetAt, hold: staged.hold, stash: { at: resetAt, value: resetStash } })) {
                        setSaveStatus("error");
                        setAccountToast(STORAGE_FULL_TOAST);
                        setTimeout(() => setAccountToast(""), 8000);
                        return;
                      }
                      const emptyFavorites = emptyModelFavorites();
                      favoriteModelsRef.current = emptyFavorites;
                      favoriteModelsUpdatedAtRef.current = resetFavoritesAt;
                      setFavoriteModelsByType(emptyFavorites);
                      setSelectedModels([]);
                      removeFailedSync("model-favorites", favoriteScope);
                      const takenUploads = [...takeQueuedUploads("task", [...plannedTaskIds]), ...takeQueuedUploads("history", [...plannedLogIds])];
                      const plan = stagePurge(staged);   // queued before the clears below fire
                      // Only the planned ids leave this device (review round 14, as in Clear Outputs): a task or History
                      // entry that arrived after the copy (another device's, or a generation started here meanwhile) stays
                      // here, as it does in the cloud. What leaves is kept for a voided reset's put-back (review round
                      // 13): the current versions removed from state, and the stored ones beyond the loaded.
                      const tasksRemovedHere = tasksRef.current.filter(t => plannedTaskIds.has(t.id));
                      const logsRemovedHere = logsRef.current.filter(l => plannedLogIds.has(l.id));
                      const loadedTaskIds = new Set(tasksRemovedHere.map(t => t.id)), loadedLogIds = new Set(logsRemovedHere.map(l => l.id));
                      const storedOnlyTasks = storedTasks.filter(t => plannedTaskIds.has(t.id) && !loadedTaskIds.has(t.id));
                      const storedOnlyLogs = storedLogs.filter(l => plannedLogIds.has(l.id) && !loadedLogIds.has(l.id));
                      const savedTasksBefore = new Set(tasksRemovedHere.filter(t => savedTaskIds.current.has(t.id)).map(t => t.id));
                      const savedLogsBefore = new Set(logsRemovedHere.filter(l => savedLogIds.current.has(l.id)).map(l => l.id));
                      const claimsBefore = claimantRecords(removedTasks.map(t => t.id));   // put back if a restore voids the reset (round 9)
                      releasePredictions(removedTasks.map(t => t.taskId)); recordClaimants(removedTasks, { deleted: true });
                      setTasks(prev => prev.filter(t => !plannedTaskIds.has(t.id)));
                      setLogs(prev => prev.filter(l => !plannedLogIds.has(l.id)));
                      for (const id of plannedTaskIds) savedTaskIds.current.delete(id);
                      for (const id of plannedLogIds) savedLogIds.current.delete(id);
                      taskSyncQueueRef.current = taskSyncQueueRef.current.filter(t => !plannedTaskIds.has(t.id));
                      if (!taskSyncQueueRef.current.length && taskSyncTimerRef.current) { clearTimeout(taskSyncTimerRef.current); taskSyncTimerRef.current = null; }
                      for (const id of plannedTaskIds) deletingIds.current.add(id);
                      for (const id of plannedLogIds) deletingLogIds.current.add(id);
                      setFailedSyncCount(getFailedSyncs().length);
                      // The local favorites setting, emptied with the rest of this device's removals (after the reservation).
                      await setSetting(localModelFavoritesKey(favoriteScope), createModelFavoritesSetting(emptyFavorites, resetFavoritesAt));
                      // Only the planned ids leave IndexedDB (review round 14): what arrived after the copy stays there.
                      await deleteTasks(clearedTaskIds);
                      await deleteHistoryEntries(clearedLogIds);
                      // Clear cloud: History, generations, settings and favorites in ONE transaction under one restore
                      // check at the reset's snapshot time (review rounds 8-10: separate calls could be half-voided by a
                      // restore landing between them). The server keeps the restore marker and the form holds. Settings and
                      // favorites are bounded by the exact snapshot (review round 11): nothing else purges them, so no
                      // slack, and this device's own last writes go too.
                      // In flight for every tab until its answer is handled (task B9, review round 22 #2; the finally ends it).
                      const resetFlight = beginDeleteFlight({ "task-delete": clearedTaskIds, "history-delete": clearedLogIds }, resetAt);
                      try {
                      const rr = await resetQueuedRemote(resetAt, clearedTaskIds, clearedLogIds, snap);
                      // Archives that finished while this reset held their tasks (round 15 S5): re-applied if voided, their
                      // files deleted if confirmed.
                      // A void gives the stash back below (round 17: with what moved into it, and its followers).
                      const heldArchives = rr.ok ? (readClearStash(resetAt)?.archives || {}) : {};
                      if (rr.ok) dropClearStash(resetAt);   // confirmed: its stash goes
                      if (rr.voided) {
                        // A restore on another device landed after this reset was queued: it wins.
                        voidDeleteIntents("task-delete", clearedTaskIds, resetAt); voidDeleteIntents("history-delete", clearedLogIds, resetAt);
                        releaseVoided(deletingIds, "task-delete", clearedTaskIds);
                        releaseVoided(deletingLogIds, "history-delete", clearedLogIds);
                        putBackClaimants(removedTasks.map(t => t.id), claimsBefore);
                        // The restore wins; nothing of this device is lost (review rounds 13, 14): the tasks, History
                        // entries (loaded and stored beyond them) and queued uploads this reset removed here come back (a
                        // version held now, or a newer queued entry, wins), and so does the local favorites state. Task B7b
                        // (review round 20 #2/#6): only what the shared delete state lets come back (storage.js
                        // inlineVoidPutBack, stashGiveBack's rule): an id pending deletion at another time joins this
                        // reset's stash for that time, one confirmed meanwhile stays gone, uploads pass the upload filter.
                        const back = inlineVoidPutBack(resetAt, { tasks: [...tasksRemovedHere, ...storedOnlyTasks], logs: [...logsRemovedHere, ...storedOnlyLogs], uploads: takenUploads });
                        const backTaskIds = new Set(back.tasks.map(t => t.id)), backIds = new Set(back.logs.map(l => l.id));
                        const tasksBack = tasksRemovedHere.filter(t => backTaskIds.has(t.id)), storedTasksBack = storedOnlyTasks.filter(t => backTaskIds.has(t.id));
                        const logsBack = logsRemovedHere.filter(l => backIds.has(l.id)), storedLogsBack = storedOnlyLogs.filter(l => backIds.has(l.id));
                        const nowTaskIds = new Set(tasksRef.current.map(t => t.id)), nowLogIds = new Set(logsRef.current.map(l => l.id));
                        // Task B13b (simulator I2, seed 12378): the stored-only copies given back that a page load would show
                        // (an earlier clear of this tab, still in its call, had taken them out of state: they are not "beyond
                        // the loaded ones") go back into state too, as loaded (saved here); the pass uploads the ones the cloud
                        // lacks (storage.js intoLoadedView). Before, they went to IndexedDB only and a History entry whose
                        // upload a restore had dropped was lost from the cloud.
                        const tasksIntoView = intoLoadedView(storedTasksBack.filter(t => t.status === "completed" || t.status === "failed"), [...tasksRef.current, ...tasksBack], { time: t => t.startTime });
                        const logsIntoView = intoLoadedView(storedLogsBack, [...logsRef.current, ...logsBack], { time: l => l.timestamp });
                        const tasksToState = [...tasksBack, ...tasksIntoView], logsToState = [...logsBack, ...logsIntoView];
                        setTasks(prev => { const have = new Set(prev.map(t => t.id)); const add = tasksToState.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
                        saveTasks([...tasksBack, ...storedTasksBack].filter(t => !nowTaskIds.has(t.id)));
                        for (const id of savedTasksBefore) if (backTaskIds.has(id)) savedTaskIds.current.add(id);
                        for (const t of tasksIntoView) savedTaskIds.current.add(t.id);
                        setLogs(prev => { const have = new Set(prev.map(l => l.id)); const add = logsToState.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
                        for (const l of [...logsBack, ...storedLogsBack]) if (!nowLogIds.has(l.id)) addHistoryEntry(l);
                        for (const id of savedLogsBefore) if (backIds.has(id)) savedLogIds.current.add(id);
                        for (const l of logsIntoView) savedLogIds.current.add(l.id);
                        putBackQueuedUploads(back.uploads);
                        // Its holds wait for the next pass after the restore (owner ruling 2026-10-23; no keepGivenBack).
                        applyRelinks([...tasksBack, ...storedTasksBack]);   // task B13a (round 26 #6): relinks already ready
                        // Favorites: only while nothing changed them since the reset (a newer choice wins). The refs, the
                        // state, the local setting with its OLD updatedAt, and the queued upload it removed.
                        if (favoriteModelsUpdatedAtRef.current === resetFavoritesAt) {
                          favoriteModelsRef.current = favoritesBefore.byType;
                          favoriteModelsUpdatedAtRef.current = favoritesBefore.updatedAt;
                          setFavoriteModelsByType(favoritesBefore.byType);
                          setSetting(localModelFavoritesKey(favoriteScope), favoritesBefore.setting ?? createModelFavoritesSetting(favoritesBefore.byType, favoritesBefore.updatedAt));
                          putBackQueuedUploads(favoritesBefore.queued);
                        }
                        // Then the stash (round 17 #1/#3): what an earlier Reset's stash merged into it during the call
                        // (the uploads that one took) and every stash whose ids moved here come back too, and its archives
                        // re-apply (round 15 S5) onto the versions put back above, which win.
                        applyClearStashes(voidedClearStashes(resetAt), { tasks: new Map([...storedTasksBack, ...tasksBack].map(t => [t.id, t])), logs: backIds });
                        setFailedSyncCount(getFailedSyncs().length);
                        setSaveStatus("idle");
                        setAccountToast("A restore on another device replaced your data while this reset waited — nothing was cleared in the cloud");
                        setTimeout(() => setAccountToast(""), 8000);
                        return;
                      }
                      // Tasks and History are re-checked and retried below (settleCloudClear); settings and favorites
                      // have no retry, so a refused reset must be reported, or the cloud copy returns on the next load.
                      const prefsLeft = rr.ok ? [] : ["settings", "favorites"];
                      if (rr.ok) queueArchivedFileDeletes(stashArchivePaths({ archives: heldArchives }));   // round 15 S5
                      // Everywhere else: WaveSpeed, all files, backup copies (History went with the reset call above). Only once the
                      // rows are gone; otherwise their intents replay first.
                      const { note: purgedNote } = rr.ok ? await purgeEverywhere(plan) : { note: "" };
                      const resetGone = rr.ok && await settleCloudClear({ tasks: clearedTaskIds, history: clearedLogIds, at: resetAt });
                      // Review round 23 #3: that confirm released the generations' held files and WaveSpeed copies: sent now.
                      const note = resetGone ? await finishPurge(plan) : purgedNote;
                      // Clear local settings
                      setBalance(null);
                      getStorageStats().then(s => setStorageStats(s));
                      if (prefsLeft.length) {
                        setSaveStatus("error");
                        setAccountToast(`Cleared here, but the cloud ${prefsLeft.join(" and ")} could not be cleared — press Reset Everything again`);
                        setTimeout(() => setAccountToast(""), 8000);
                        return;
                      }
                      if (!resetGone) {
                        setSaveStatus("error");
                        setAccountToast("Everything cleared here — the cloud clear will finish on your next save or reload");
                        setTimeout(() => setAccountToast(""), 6000);
                        return;
                      }
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast(bk.id ? `Everything cleared — safety backup saved${note}` : note ? `Everything cleared${note}` : "Everything cleared permanently, everywhere");
                      setTimeout(() => setAccountToast(""), 5000);
                      } finally { endDeleteFlight(resetFlight); }
                    }}>Reset Everything</button>
                  </div>
                </div>

                {/* Cloud Backups */}
                <div className="setting-group">
                  <div className="setting-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>Cloud Backups</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="api-test-btn" style={{ padding: "6px 12px", fontSize: 11 }} onClick={async () => {
                        setSaveStatus("saving");
                        const r = await createBackup("manual", "Manual snapshot");
                        if (r.ok) { setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000); setAccountToast("Backup created"); setTimeout(() => setAccountToast(""), 4000); }
                        else { setSaveStatus("error"); setAccountToast("Backup failed: " + (r.error || "unknown")); setTimeout(() => setAccountToast(""), 5000); }
                        const list = await listBackups(20);
                        setBackups(list);
                      }}>+ Create Backup</button>
                      <button className="api-test-btn" title="Reload backups from cloud" style={{ padding: "6px 10px", fontSize: 11, background: "rgba(30,41,59,0.5)", color: "var(--text-secondary)" }} onClick={async () => {
                        setBackupsReloading(true);
                        const list = await listBackups(20);
                        setBackups(list);
                        setBackupsReloading(false);
                        setAccountToast(`Reloaded · ${list.length} backups`);
                        setTimeout(() => setAccountToast(""), 3000);
                      }}>{backupsReloading ? "↻…" : "↻ Reload"}</button>
                      <button className="api-test-btn" style={{ padding: "6px 12px", fontSize: 11, background: "rgba(30,41,59,0.5)", color: "var(--text-secondary)" }} onClick={async () => {
                        if (!showBackupsPanel) { const list = await listBackups(20); setBackups(list); }
                        setShowBackupsPanel(v => !v);
                      }}>{showBackupsPanel ? "Hide" : "View"} ({backups.length || "·"})</button>
                    </div>
                  </div>

                  {/* Automatic backups switch (server-side, off by default; owner, 2026-10-21). Manual snapshots above
                      always work; this covers the 2-day job and the safety copies before deletes, clears and restores. */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "6px 0 12px" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text-primary)" }}>Automatic backups</div>
                      <div className="setting-hint" style={{ marginTop: 2 }}>
                        {autoBackupsChecking ? "Checking…"
                          : autoBackups === null ? "Couldn't check it. Tap the switch to try again."
                          : autoBackups ? "On: a safety copy before every delete, clear or restore, and every 2 days. Deleted generations can be restored."
                          : "Off: nothing is copied. Deleting is final everywhere: this device, the cloud, WaveSpeed and backups."}
                      </div>
                    </div>
                    <button type="button" role="switch" aria-checked={!!autoBackups} aria-label="Automatic backups" disabled={autoBackupsChecking}
                      onClick={async () => {
                        if (autoBackups === null) { readAutoBackups(); return; }   // unknown: a tap retries the read
                        const next = !autoBackups;
                        // Owner rulings on #7 (2026-10-22): switching off scrubs every existing backup of what was already
                        // deleted, restore-replaced rows included (migration 20261021175200).
                        if (!next && !confirm("Turn Automatic backups off?\n\nFrom now on nothing is copied, and every existing backup loses the generations and History you have already deleted, including what a restore replaced (so a restore can no longer be undone). Turning it back on does not bring them back.")) return;
                        try {
                          const v = await setAutoBackups(next);
                          setAutoBackupsState(v);
                          setAccountToast(v ? "Automatic backups on" : "Automatic backups off — deletes are now final, and deleted items are being removed from your backups");
                        } catch (e) {
                          setAccountToast("Couldn't change Automatic backups: " + (e?.message || "unknown error"));
                        }
                        setTimeout(() => setAccountToast(""), 4000);
                      }}
                      style={{ flex: "0 0 auto", width: 56, height: 44, display: "flex", alignItems: "center", justifyContent: "center",
                        background: "transparent", border: "none", cursor: autoBackupsChecking ? "default" : "pointer", padding: 0 }}>
                      <span aria-hidden="true" style={{ width: 44, height: 24, borderRadius: 12, position: "relative", transition: "background 0.2s",
                        background: autoBackups ? "var(--accent)" : "rgba(148,163,184,0.35)", opacity: autoBackups === null ? 0.5 : 1 }}>
                        <span style={{ position: "absolute", top: 2, left: autoBackups ? 22 : 2, width: 20, height: 20, borderRadius: 10,
                          background: "#fff", transition: "left 0.2s" }} />
                      </span>
                    </button>
                  </div>

                  {/* Sync & Backup status strip */}
                  {(() => {
                    const fmtRel = (ts) => {
                      if (!ts) return "never";
                      const diff = Date.now() - ts;
                      const s = Math.round(diff / 1000);
                      if (s < 45) return "just now";
                      const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
                      const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
                      const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
                      return new Date(ts).toLocaleDateString();
                    };
                    const fmtAbs = (ts) => ts ? new Date(ts).toLocaleString() : "";
                    const lastBackupTs = backups[0] ? new Date(backups[0].created_at).getTime() : null;
                    const lastBackupType = backups[0]?.backup_type;
                    const lastRestoreStr = localStorage.getItem("proximaai_last_restore_at");
                    const lastRestoreTs = lastRestoreStr ? parseInt(lastRestoreStr, 10) : null;
                    const lastSyncStr = localStorage.getItem("proximaai_last_sync_at");
                    const lastSyncTs = lastSyncStr ? parseInt(lastSyncStr, 10) : null;
                    return (
                      <div style={{
                        display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "6px 12px",
                        padding: "10px 12px", marginTop: 10, marginBottom: 10,
                        background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)",
                        borderRadius: 10, fontSize: 11, alignItems: "center",
                      }}>
                        <span style={{ color: "#10b981", fontSize: 12 }}>●</span>
                        <div>
                          <div style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Last cloud sync</div>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{fmtRel(lastSyncTs)}</div>
                        </div>
                        <span title={fmtAbs(lastSyncTs)} style={{ color: "var(--text-muted)", fontSize: 10, fontFamily: font }}>{fmtAbs(lastSyncTs)}</span>

                        <span style={{ color: "#818cf8", fontSize: 12 }}>✦</span>
                        <div>
                          <div style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Last backup</div>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                            {lastBackupTs ? `${fmtRel(lastBackupTs)}${lastBackupType ? ` · ${lastBackupType}` : ""}` : "never"}
                          </div>
                        </div>
                        <span title={fmtAbs(lastBackupTs)} style={{ color: "var(--text-muted)", fontSize: 10, fontFamily: font }}>{fmtAbs(lastBackupTs)}</span>

                        <span style={{ color: "#f59e0b", fontSize: 12 }}>↻</span>
                        <div>
                          <div style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Last restore</div>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{fmtRel(lastRestoreTs)}</div>
                        </div>
                        <span title={fmtAbs(lastRestoreTs)} style={{ color: "var(--text-muted)", fontSize: 10, fontFamily: font }}>{lastRestoreTs ? fmtAbs(lastRestoreTs) : ""}</span>
                      </div>
                    );
                  })()}

                  <div className="setting-hint">Auto-backup runs every 2 days. Manual backups are saved immediately. While Automatic backups is on, deletes, clears and restores take a safety backup first. Rolling retention: 30 auto + all manual.</div>
                  {showBackupsPanel && (
                    <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10, padding: 6 }}>
                      {backups.length === 0 ? (
                        <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>No backups yet. Click "+ Create Backup" above to make one.</div>
                      ) : backups.map(b => (
                        <div key={b.id} style={{ padding: "10px 12px", borderBottom: "1px solid rgba(56,68,100,0.15)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
                              {b.backup_type === "manual" ? "📌 Manual" : b.backup_type === "auto-2day" ? "🔁 Auto (2-day)" : b.backup_type.startsWith("pre-") ? "🛡️ " + b.backup_type.replace("pre-", "Pre-") : b.backup_type}
                              <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 400, marginLeft: 8, fontFamily: font }}>
                                {b.task_count} tasks · {b.history_count} logs
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontFamily: font }}>{formatTimestamp(b.created_at)}</div>
                            {b.note && <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 2, fontStyle: "italic" }}>{b.note}</div>}
                          </div>
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            <button onClick={async () => {
                              const ab = await readAutoBackups();
                              if (!confirm(`Restore this backup from ${formatTimestamp(b.created_at)}?\n\nThis replaces current data with the snapshot. ${backupNotice(ab, { restore: true })}`)) return;
                              setSaveStatus("saving");
                              const r = await restoreBackup(b.id);
                              if (r.ok) {
                                try { localStorage.setItem("proximaai_last_restore_at", String(Date.now())); } catch {}
                                setAccountToast(`Restored ${r.tasks} tasks, ${r.history} logs. Refresh to see changes.`);
                                setTimeout(() => setAccountToast(""), 6000);
                                setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000);
                                const list = await listBackups(20); setBackups(list);
                                setTimeout(() => window.location.reload(), 1500);
                              } else {
                                setSaveStatus("error");
                                setAccountToast("Restore failed: " + (r.error || "unknown"));
                                setTimeout(() => setAccountToast(""), 5000);
                              }
                            }} style={{ padding: "5px 10px", fontSize: 10, background: "rgba(99,102,241,0.12)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font, fontWeight: 600 }}>Restore</button>
                            <button onClick={async () => {
                              if (!confirm("Delete this backup permanently?")) return;
                              await deleteBackup(b.id);
                              const list = await listBackups(20); setBackups(list);
                            }} style={{ padding: "5px 9px", fontSize: 10, background: "transparent", color: "var(--error)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font }}>✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <VersionInfo />
              </div>
            )}
          </div>
        </div>

        {/* Floating Save Status Button — always visible, bottom-left */}
        {/* Account Modal */}
        {showAccountModal && (
          <AccountModal
            onClose={() => setShowAccountModal(false)}
            onPasswordReset={() => {
              setShowAccountModal(false);
              signOutLocal();
              setSessionNotice("Password reset. Every device was signed out — sign in with your new password.");
            }}
            onSaved={(msg) => {
              setAccountToast(msg);
              setTimeout(() => setAccountToast(""), 5000);
            }}
          />
        )}

        {/* Lightbox */}
        {lightbox && (() => {
          const lbUrl = typeof lightbox === "string" ? lightbox : lightbox.url;
          const lbTask = typeof lightbox === "object" ? lightbox.task : null;
          const isVid = lbUrl?.includes(".mp4") || lbUrl?.includes("video");
          return (
            <div className="lightbox" onClick={() => setLightbox(null)}>
              <button type="button" className="lightbox-close" aria-label="Close full-screen preview" title="Close preview"
                autoFocus onClick={e => { e.stopPropagation(); setLightbox(null); }}>×</button>
              <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "94vw", maxHeight: "94vh" }}>
                {isVid
                  ? <video src={lbUrl} controls autoPlay muted style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10 }} />
                  : <img src={lbUrl} alt="Full resolution" style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10, objectFit: "contain" }} />}
                {lbTask && (
                  <div style={{ marginTop: 10, padding: "12px 16px", background: "rgba(8,12,25,0.85)", borderRadius: 10, width: "92vw", maxHeight: "22vh", overflowY: "auto", border: "1px solid var(--glass-border)" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{lbTask.modelName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{lbTask.prompt}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6 }}>
                      <span>Provider: {lbTask.provider}</span>
                      <span>Time: {formatTime(lbTask.wallClockMs)}</span>
                      <span>Cost: {formatCost(lbTask.price)}</span>
                      <span>Seed: {lbTask.seed || "-1"}</span>
                      <span>{lbTask.endTime ? formatTimestamp(lbTask.endTime) : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="result-action-btn" onClick={async () => {
                        try { const r = await fetch(lbUrl); const b = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${lbTask.modelName.replace(/\s+/g,"_")}_${Date.now()}.${isVid?"mp4":"png"}`; a.click(); URL.revokeObjectURL(a.href); } catch { window.open(lbUrl,"_blank"); }
                      }}>↓ Save</button>
                      <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(lbUrl); }}>📋 URL</button>
                      <button className="result-action-btn" onClick={() => setLightbox(null)}>✕ Close</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
