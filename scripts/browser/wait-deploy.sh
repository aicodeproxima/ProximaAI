#!/bin/sh
# Wait until the live ProximaAI index.html or JS bundle contains <marker> (a string your change added), then print
# the bundle hash.
# Usage: sh scripts/browser/wait-deploy.sh '<marker>' [tries=40] [site=https://proxima-ai-seven.vercel.app]
# Polls every 5 s with a cache-busting query; exit 0 on the first hit, 1 after <tries>.
MARKER="$1"; TRIES="${2:-40}"; SITE="${3:-https://proxima-ai-seven.vercel.app}"
[ -n "$MARKER" ] || { echo "usage: wait-deploy.sh '<marker>' [tries] [site]" >&2; exit 2; }
i=1
while [ "$i" -le "$TRIES" ]; do
  html=$(curl -sL "$SITE/?v=$$-$i")
  js=$(printf "%s" "$html" | grep -o 'assets/index-[^"]*\.js' | head -1)
  if printf "%s" "$html" | grep -qF -- "$MARKER"; then echo "LIVE after ~$((i * 5))s (in index.html): $js"; exit 0; fi
  if [ -n "$js" ] && curl -sL "$SITE/$js" | grep -qF -- "$MARKER"; then echo "LIVE after ~$((i * 5))s: $js"; exit 0; fi
  sleep 5; i=$((i + 1))
done
echo "TIMEOUT after $((TRIES * 5))s; live bundle: ${js:-none}"; exit 1
