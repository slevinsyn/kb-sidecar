#!/usr/bin/env python3
"""Tell the person the build is finished or needs them.

  notify.py "<title>" "<message>"

Sends a desktop notification (macOS, Linux, Windows) and, if `notify_webhook` is set in
.phased/config.json, posts {"text", "title", "message"} to that URL (works with Slack,
Microsoft Teams and ntfy.sh incoming webhooks, which can reach your phone).
Best effort: it never fails the build.
"""
import json
import platform
import shutil
import subprocess
import sys
import urllib.request
sys.dont_write_bytecode = True
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def desktop(title, msg):
    name = platform.system()
    try:
        if name == "Darwin" and shutil.which("osascript"):
            script = f'display notification {json.dumps(msg)} with title {json.dumps(title)} sound name "Glass"'
            subprocess.run(["osascript", "-e", script], timeout=10, capture_output=True)
            return "desktop"
        if name == "Linux" and shutil.which("notify-send"):
            subprocess.run(["notify-send", title, msg], timeout=10, capture_output=True)
            return "desktop"
        if name == "Windows" and shutil.which("powershell"):
            t, m = title.replace("'", "''"), msg.replace("'", "''")
            ps = ("Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; "
                  "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; "
                  f"$n.ShowBalloonTip(10000, '{t}', '{m}', 'Info'); Start-Sleep -Seconds 6; $n.Dispose()")
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], timeout=20, capture_output=True)
            return "desktop"
    except Exception:
        pass
    return None


def webhook(url, title, msg):
    try:
        body = json.dumps({"text": f"{title}: {msg}", "title": title, "message": msg}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
        return "webhook"
    except Exception:
        return None


def main(argv):
    title = argv[1] if len(argv) > 1 else "Build"
    msg = argv[2] if len(argv) > 2 else ""
    sent = [desktop(title, msg)]
    cfg = C.load_config(C.find_root()) or {}
    if cfg.get("notify_webhook"):
        sent.append(webhook(cfg["notify_webhook"], title, msg))
    sys.stdout.write("\a")
    C.say("notified: " + (", ".join(s for s in sent if s) or "terminal only"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
