// ─── The line every destructive confirm ends with ───
// It states what the Automatic backups switch will really do: the server takes the safety copy only while the switch
// is on. `on` is the switch as read just before the confirm: true, false, or null when it couldn't be read (then the
// server still decides, so the line must not claim either way). `what` names the deleted thing ("it", "them").
export function backupNotice(on, { what = "it", restore = false } = {}) {
  if (on === true) return restore
    ? "Automatic backups is on: a safety backup of your current data is taken first."
    : "Automatic backups is on: a safety backup is taken first, so you can restore from Settings → Cloud Backups.";
  if (on === false) return restore
    ? "Your current data is replaced permanently: nothing is copied first (Automatic backups is off)."
    : `This is permanent: nothing can restore ${what} (Automatic backups is off).`;
  return "The Automatic backups switch couldn't be checked: if it is on, a safety backup is taken first; if it is off, this is permanent.";
}
