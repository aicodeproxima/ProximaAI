#!/bin/sh
# ProximaAI copy (2026-10-20): run `sh scripts/browser/phone-watchdog.sh` in the background; state + log in $PHONE_STATE_DIR.
# watchdog-v5.sh - the owner's phone (R5CX13P78NW) during my drives. v4 + self-healing (2026-09-19 10:00Z):
#  1. LOCK RULE (owner 2026-09-19): if the foreground app is not Chrome and no pause flag exists,
#     send KEYCODE_SLEEP, log LOCKED, print LOCKED to stdout - then RE-ARM (wait for Chrome in front +
#     keyguard down again) instead of exiting: a dead watchdog leaves the phone unprotected.
#     My own moves that leave Chrome must `touch $PAUSE` first.
#  2. KEEP AWAKE without fake input: every 60s, while Chrome is in front and the keyguard is down, hold
#     a Screen Wake Lock from the ProximaAI tab over CDP (navigator.wakeLock.request('screen')).
#     Measured 2026-09-19: KEYCODE_WAKEUP is a no-op for the idle timer while the screen is on, and a
#     SHIFT key on the keyguard moved mLastUserActivityTime by 0ms - input injection cannot do this job.
#  3. SELF-HEAL (measured 10:00Z the same day): a USB unplug drops `adb forward tcp:9333`, so after a
#     reconnect the phone read healthy while the wake lock silently read EMPTY. Now: the forward is
#     re-created whenever the wake lock does not answer "held"; an adb loss waits for the device
#     (`adb wait-for-device`) instead of giving up after 10 min, then re-forwards and re-arms.
#  4. A dozing phone is woken once (KEYCODE_WAKEUP) so its keyguard shows; the owner unlocks it.
S="${PHONE_STATE_DIR:-${TMPDIR:-/tmp}/proxima-phone}"; mkdir -p "$S"
LOG="$S/phone-keepalive.log"; PAUSE="$S/watchdog-pause"; CDP="$(cd "$(dirname "$0")" && pwd)/cdp.mjs"
export GC_PORT=9333
fg() { adb shell dumpsys activity activities 2>/dev/null | grep -m1 -oE "topResumedActivity=ActivityRecord\{[^}]*" | sed -E 's/.* u0 ([^/ ]+).*/\1/'; }
kg() { adb shell dumpsys window 2>/dev/null | grep -m1 -oE "isKeyguardShowing=[a-z]+" | cut -d= -f2; }
wk() { adb shell dumpsys power 2>/dev/null | grep -oE "mWakefulness=[A-Za-z]+" | head -1 | cut -d= -f2; }
dev() { adb get-state 2>/dev/null; }
forward() { adb forward --list 2>/dev/null | grep -q "tcp:9333" || { adb forward tcp:9333 localabstract:chrome_devtools_remote >/dev/null 2>&1 && echo "$(date -u +%T) re-forwarded tcp:9333 -> chrome_devtools_remote" >> "$LOG"; }; }
wakelock() { GC_ANY=1 node "$CDP" eval '(async()=>{try{ if(!window.__gcWL||window.__gcWL.released){ window.__gcWL=await navigator.wakeLock.request("screen"); window.__gcWL.addEventListener("release",()=>{window.__gcWLReleasedAt=Date.now()}); } return "held"; }catch(e){ return "ERR "+e.name+": "+e.message; }})()' 2>/dev/null | tr -d '"'; }
wakelock_healed() { wl=$(wakelock); if [ "$wl" != "held" ]; then forward; sleep 1; wl=$(wakelock); fi; echo "$wl"; }
rm -f "$PAUSE"
echo "$(date -u +%T) WATCHDOG v5 start (v4 rules + self-healing forward + wait-for-device + re-arm after LOCK)" >> "$LOG"
while true; do
  # --- arm: wait for the device, Chrome in front, keyguard down ---
  w=0
  until [ "$(dev)" = "device" ] && [ "$(fg)" = "com.android.chrome" ] && [ "$(kg)" = "false" ]; do
    sleep 10; w=$((w+1))
    if [ "$(dev)" != "device" ]; then
      [ $((w % 6)) -eq 0 ] && echo "$(date -u +%T) no adb device; waiting" >> "$LOG"
    else
      [ $((w % 30)) -eq 0 ] && echo "$(date -u +%T) still waiting for Chrome in front + keyguard down (fg=$(fg) wake=$(wk))" >> "$LOG"
    fi
  done
  forward
  echo "$(date -u +%T) ARMED (Chrome in front, unlocked); wakelock=$(wakelock_healed)" >> "$LOG"
  echo "ARMED $(date -u +%T)"
  # --- run ---
  miss=0; last=0
  while true; do
    f=$(fg); k=$(kg); s=$(wk); now=$(date +%s)
    if [ -z "$f" ]; then
      if [ "$s" = "Dozing" ] || [ "$s" = "Asleep" ]; then
        echo "$(date -u +%T) phone asleep ($s); waking once so the owner can unlock" >> "$LOG"
        adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
        sleep 30; continue
      fi
      miss=$((miss+1)); echo "$(date -u +%T) no foreground read (wake=$s dev=$(dev)) miss=$miss" >> "$LOG"
      if [ $miss -ge 4 ]; then
        echo "$(date -u +%T) adb lost for ~1 min; waiting for the device to come back (wait-for-device)" >> "$LOG"
        echo "ADB LOST $(date -u +%T)"
        adb wait-for-device >/dev/null 2>&1
        sleep 3
        echo "$(date -u +%T) device is back ($(dev)); re-forwarding and re-arming" >> "$LOG"
        break
      fi
      sleep 15; continue
    fi
    miss=0
    if [ "$f" != "com.android.chrome" ] && [ ! -f "$PAUSE" ]; then
      adb shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1
      echo "$(date -u +%T) LOCKED: foreground=$f left Chrome with no pause flag; re-arming once the owner unlocks onto Chrome" >> "$LOG"
      echo "LOCKED foreground=$f $(date -u +%T)"
      sleep 20
      break
    fi
    if [ "$k" = "false" ] && [ $((now - last)) -ge 60 ]; then
      last=$now
      echo "$(date -u +%T) fg=$f wake=$s keyguard=$k wakelock=$(wakelock_healed) pause=$([ -f "$PAUSE" ] && echo yes || echo no)" >> "$LOG"
    fi
    sleep 15
  done
done
