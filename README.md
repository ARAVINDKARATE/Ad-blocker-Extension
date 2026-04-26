# Multi-Site Ad Skipper

A Chrome extension (Manifest V3) that skips video ads on **Prime Video** and **YouTube**, and blocks common ad-network requests across the rest of the web.

## Features

- **Prime Video** — detects ad state from the player UI, mutes the audio, fast-forwards at 16× and (when a countdown is readable) seeks past the ad pod. A black "Skipping ad…" cover hides the fast-forwarded frames.
- **YouTube** — clicks the "Skip Ad" button when it appears; for non-skippable ads, jumps to the end of the ad video so the player advances to content.
- **Network-level ad blocking** — uses `declarativeNetRequest` to block ~29 common ad networks (DoubleClick, Google Syndication, Taboola, Outbrain, Criteo, PubMatic, OpenX, Amazon Ad System, etc.) on every site. Always on.
- **Toggle** — popup checkbox enables/disables the in-player skipping (network blocking stays on either way).

## Install (unpacked)

1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to the toolbar to access the popup toggle.

## How it works

### Player skipping ([content.js](content.js))

The content script runs on Prime Video, Amazon video pages, and YouTube. It uses per-site adapters that expose:

- `isAd()` — read the player DOM to decide whether an ad is playing
- `trySkip()` — click an instant-skip button if one exists (YouTube)
- `attemptSeek(video)` — jump past the ad when safe

A 250 ms tick + `MutationObserver` drives the loop. When an ad is detected, the script:

1. Mutes the video and sets `playbackRate = 16`.
2. Shows a fixed black cover sized to the video's bounding rect (re-parented into the fullscreen subtree when fullscreen is active).
3. Tries an instant skip; otherwise tries a single seek per ad break.
4. Restores the previous playback rate / mute state when ad state clears.

### Safety guards

Prime's SSAI-based player is fragile under aggressive seeking, so the script has several backstops:

- **Episode-start grace** — no seeks for 10 s after a `currentSrc` change (manifest still loading).
- **Buffer guard** — no seek or fast-forward if `readyState < HAVE_FUTURE_DATA` (3).
- **Slow-network detection** — uses the Network Information API (`saveData`, `effectiveType`, `downlink`, `rtt`); seeks are disabled for the rest of the video on slow links. Fast-forward only.
- **Seek pacing** — one seek in flight at a time, 3 s post-seek grace, 4 s timeout fallback if `seeked` never fires.
- **Per-break seek cap** — `MAX_TOTAL_SEEK_DELTA = 90 s` per break; further skipping is fast-forward only.
- **Hard timeout** — if ad-state persists > 30 real-time seconds, give up and disable seeks for the rest of the video to avoid Prime's `playback_waiting_timeout` crash.

### Network blocking ([rules.json](rules.json))

29 `declarativeNetRequest` block rules targeting script, image, xhr, sub-frame, ping, media, and websocket requests to known ad-network hosts.

## Files

- [manifest.json](manifest.json) — MV3 manifest (permissions, content-script matches, DNR rule resource).
- [content.js](content.js) — per-site ad detection, seek/fast-forward logic, cover overlay.
- [rules.json](rules.json) — declarative network-blocking rules.
- [popup.html](popup.html) / [popup.js](popup.js) — toolbar popup with the enable toggle (state stored in `chrome.storage.sync`).

## Permissions

- `storage` — persist the toggle state across browser sessions.
- `activeTab` — interact with the current tab when the popup is opened.
- `declarativeNetRequest` — apply the static block list in [rules.json](rules.json).
- Host permissions for Prime Video / Amazon video / YouTube domains (content-script injection only).

## Debugging

The content script logs to the page console with the `[ad-skipper]` prefix, including:

- adapter + version on load
- ad-detection events and current playback time
- seek attempts and cumulative delta
- network classification when seeks are disabled
- give-up events

Open DevTools on the video page to follow along.

## Limitations

- Prime uses server-side ad insertion (SSAI), so there is no client-side "Skip" button — the script can only fast-forward and (when a countdown is visible) seek past the pod.
- Aggressive seeking on slow links has been observed to wedge Prime's player; the script intentionally falls back to fast-forward-only in those cases rather than retry.
- Detection is DOM-based and will need updates if the player markup changes.
