(() => {
  const SKIP_RATE = 16;
  const POLL_MS = 250;

  const state = {
    enabled: true,
    inAd: false,
    savedRate: 1,
    savedMuted: false,
    badge: null,
  };

  chrome.storage?.sync.get({ enabled: true }, (v) => {
    state.enabled = v.enabled;
  });
  chrome.storage?.onChanged.addListener((changes) => {
    if (changes.enabled) state.enabled = changes.enabled.newValue;
  });

  // ── Per-site adapters ──────────────────────────────────────────────────────
  // Each adapter exposes:
  //   match(host): boolean
  //   isAd(): boolean   — is the player currently showing an ad?
  //   trySkip(video): boolean — attempt an *instant* skip (e.g. click "Skip Ad" button)
  //   attemptSeek(video): boolean — try seeking past the ad. The player may revert it
  //                                  (Prime SSAI does), in which case fast-forward kicks in.

  const primeAdapter = {
    name: 'prime',
    match: (h) =>
      /(^|\.)primevideo\.com$/.test(h) ||
      /(^|\.)amazon\.[a-z.]+$/.test(h),
    isAd() {
      if (document.querySelector('.atvwebplayersdk-adtimeindicator-text')) return true;
      if (document.querySelector('[class*="adtimeindicator"]')) return true;
      const badges = document.querySelectorAll(
        '.atvwebplayersdk-adbadge-text, [class*="adbadge"], [data-testid*="ad-badge"]'
      );
      if (badges.length) return true;
      const overlay = document.querySelector('.webPlayerSDKContainer, #dv-web-player');
      if (overlay) {
        for (const el of overlay.querySelectorAll('span, div')) {
          if (el.children.length) continue;
          const t = (el.textContent || '').trim();
          if (t === 'Ad' || t === 'Advertisement' || /^Ad\s*[·•|]/.test(t)) return true;
        }
      }
      return false;
    },
    getAdRemainingSeconds() {
      const els = document.querySelectorAll(
        '.atvwebplayersdk-adtimeindicator-text, [class*="adtimeindicator"], [class*="ad-time"], [class*="adcountdown"]'
      );
      for (const el of els) {
        const text = (el.textContent || '').trim();
        const mmss = text.match(/(\d+):(\d{2})\b/);
        if (mmss) return parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10);
        const secs = text.match(/(\d+)\s*s\b/i);
        if (secs) return parseInt(secs[1], 10);
      }
      return null;
    },
    trySkip() { return false; }, // Prime has no client-side skip button — SSAI.
    attemptSeek(video) {
      // Only seek when we can read the exact remaining time from the countdown.
      // A blind fixed jump overshoots short ad pods (~30-60s) and eats real
      // content. Without the countdown, fast-forward at SKIP_RATE handles it
      // — a 60s ad at 16x takes <4 real seconds, no risk of overshoot.
      const remaining = this.getAdRemainingSeconds();
      console.log('[ad-skipper] countdown read:', remaining);
      if (remaining == null) return false;
      try {
        video.currentTime = video.currentTime + remaining + 1;
        return true;
      } catch { return false; }
    },
  };

  const youtubeAdapter = {
    name: 'youtube',
    match: (h) => /(^|\.)youtube\.com$/.test(h) || /(^|\.)youtube-nocookie\.com$/.test(h),
    isAd() {
      const player = document.querySelector('.html5-video-player');
      if (player && player.classList.contains('ad-showing')) return true;
      if (document.querySelector('.ytp-ad-player-overlay, .ytp-ad-overlay-container')) return true;
      if (document.querySelector('[class*="ytp-ad-"]:not(.ytp-ad-skip-button-container)')) {
        return !!document.querySelector('.html5-video-player.ad-showing');
      }
      return false;
    },
    trySkip() {
      const selectors = [
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button',
        '.ytp-skip-ad-button',
        'button[class*="ytp-ad-skip"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      return false;
    },
    attemptSeek(video) {
      // For non-skippable YouTube ads, jumping to near the end of the ad video
      // often makes the player consider the ad complete and advance to content.
      if (!isFinite(video.duration) || video.duration <= 0) return false;
      try {
        video.currentTime = Math.max(0, video.duration - 0.1);
        return true;
      } catch { return false; }
    },
  };

  const adapters = [primeAdapter, youtubeAdapter];
  const adapter = adapters.find((a) => a.match(location.hostname));
  if (!adapter) return; // Generic web ads handled by declarativeNetRequest in the background.

  const VERSION = '0.3.1-episode-start-grace';
  const log = (...args) => console.log('[ad-skipper]', ...args);
  log(`loaded on ${adapter.name} (${location.hostname}) — v${VERSION}`);

  // Slow networks can't sustain forward seeks during ad breaks — even a single
  // 90s jump can push Prime's player into `playback_waiting_timeout`. We detect
  // slow connections via the Network Information API and disable seeking when
  // present; fast-forward + black cover still hides ad frames.
  function detectSlowNetwork() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return { slow: false, reason: 'no Network Info API' };
    if (conn.saveData) return { slow: true, reason: 'save-data on' };
    if (['slow-2g', '2g', '3g'].includes(conn.effectiveType)) {
      return { slow: true, reason: `effectiveType=${conn.effectiveType}` };
    }
    if (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 5) {
      return { slow: true, reason: `downlink=${conn.downlink}Mbps` };
    }
    if (typeof conn.rtt === 'number' && conn.rtt > 300) {
      return { slow: true, reason: `rtt=${conn.rtt}ms` };
    }
    return { slow: false, reason: `effectiveType=${conn.effectiveType}, downlink=${conn.downlink}Mbps, rtt=${conn.rtt}ms` };
  }

  // ── Player control ─────────────────────────────────────────────────────────

  function getVideo() {
    const vids = document.getElementsByTagName('video');
    let best = null;
    for (const v of vids) {
      if (!v.src && !v.currentSrc) continue;
      if (!best || v.duration > best.duration) best = v;
    }
    return best || vids[0] || null;
  }

  function showBadge(text) {
    if (!state.badge) {
      const el = document.createElement('div');
      el.style.cssText = [
        'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
        'background:rgba(0,0,0,0.75)', 'color:#fff', 'padding:6px 10px',
        'font:600 12px/1 system-ui,sans-serif', 'border-radius:6px',
        'pointer-events:none', 'transition:opacity .2s', 'opacity:0',
      ].join(';');
      document.documentElement.appendChild(el);
      state.badge = el;
    }
    state.badge.textContent = text;
    state.badge.style.opacity = '1';
  }
  function hideBadge() {
    if (state.badge) state.badge.style.opacity = '0';
  }

  // Black cover overlay shown during ad state so the user doesn't see the
  // fast-forwarded ad frames. Positioned over the video's bounding rect via
  // `position: fixed`; reparented into the fullscreen subtree when one exists
  // so it remains visible in fullscreen mode.
  function ensureCover() {
    if (!state.cover) {
      const el = document.createElement('div');
      el.style.cssText = [
        'position:fixed', 'background:#000',
        'z-index:2147483646', 'pointer-events:none',
        'display:none', 'opacity:0', 'transition:opacity .15s',
        'color:#fff', 'font:500 14px/1 system-ui,sans-serif',
        'align-items:center', 'justify-content:center',
      ].join(';');
      el.textContent = 'Skipping ad…';
      state.cover = el;
    }
    const target = document.fullscreenElement || document.documentElement;
    if (state.cover.parentElement !== target) target.appendChild(state.cover);
    return state.cover;
  }

  function positionCover(video) {
    const cover = ensureCover();
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cover.style.left = rect.left + 'px';
    cover.style.top = rect.top + 'px';
    cover.style.width = rect.width + 'px';
    cover.style.height = rect.height + 'px';
  }

  function showCover(video) {
    const cover = ensureCover();
    positionCover(video);
    cover.style.display = 'flex';
    requestAnimationFrame(() => { cover.style.opacity = '1'; });
  }

  function hideCover() {
    if (!state.cover) return;
    state.cover.style.opacity = '0';
    setTimeout(() => {
      if (state.cover) state.cover.style.display = 'none';
    }, 200);
  }

  function enterAd(video) {
    if (state.inAd) return;
    state.inAd = true;
    state.savedRate = video.playbackRate || 1;
    state.savedMuted = video.muted;
    state.adStartTime = video.currentTime;
    state.adEnteredAt = Date.now();
    state.totalSeekDelta = 0;
    state.seekingDisabled = false;
    try { video.muted = true; } catch {}
    try { video.playbackRate = SKIP_RATE; } catch {}
    showBadge('Skipping ad…');
    showCover(video);
    log(`ad detected at ${video.currentTime.toFixed(1)}s — fast-forwarding`);
  }

  function exitAd(video) {
    if (!state.inAd) return;
    state.inAd = false;
    state.adStartTime = null;
    state.adEnteredAt = null;
    state.totalSeekDelta = 0;
    state.seekingDisabled = false;
    try { video.playbackRate = state.savedRate || 1; } catch {}
    try { video.muted = state.savedMuted; } catch {}
    hideBadge();
    hideCover();
    log('ad ended');
  }

  // Seek pacing: only one seek in flight at a time, and give the player a
  // grace period after each seek to update its UI / buffer state before we
  // re-evaluate. Without this, transient "loading" UI gets misread as "ad"
  // and we runaway-seek to nowhere.
  let seekInFlight = false;
  let lastSeekedAt = 0;
  // Once a give-up timeout fires, we stop seeking for the rest of this video.
  // Continuing to seek aggressively after one stuck event has been observed
  // to push Prime's player into `playback_waiting_timeout` ("error playing
  // your video"). We reset this when the video source changes.
  let sessionSeekDisabled = false;
  let lastVideoSrc = null;
  // Time of last video source change. Seeking too soon after a source switch
  // (new episode, new movie) wedges Prime's player — the manifest is still
  // loading and our seek fires a "Content change superseded" + 20s timeout.
  // Hold off seeks for an episode-start grace period; fast-forward still runs.
  let videoSrcChangedAt = 0;
  const SRC_CHANGE_GRACE_MS = 10000;
  const POST_SEEK_GRACE_MS = 3000;
  const SEEK_TIMEOUT_MS = 4000;
  // Cap matches the seek jump size — effectively one seek per ad break. On
  // slow networks, 2+ consecutive seeks thrash Prime's buffer hard enough
  // that the player tears itself down (LoadCancelled / TimeoutError).
  const MAX_TOTAL_SEEK_DELTA = 90;
  const MAX_AD_DURATION_MS = 30000; // give up after 30 real-time seconds stuck in ad

  let attachedVideo = null;
  function attachVideoListeners(video) {
    if (attachedVideo === video) return;
    attachedVideo = video;
    video.addEventListener('seeked', () => {
      seekInFlight = false;
      lastSeekedAt = Date.now();
      // The seek may have landed past the ad. Drop to 1x immediately so we
      // don't fast-forward into post-ad show content while waiting for the
      // next tick to re-evaluate ad state. If we're still in an ad, the
      // next tick will reapply SKIP_RATE.
      if (state.inAd) {
        try { video.playbackRate = 1; } catch {}
      }
    });
  }

  function tick() {
    if (!state.enabled) {
      const v = getVideo();
      if (v && state.inAd) exitAd(v);
      return;
    }
    const video = getVideo();
    if (!video) return;
    attachVideoListeners(video);

    // Reset per-video state when the source changes (new episode, new movie).
    const currentSrc = video.currentSrc || video.src || '';
    if (lastVideoSrc !== currentSrc) {
      if (lastVideoSrc !== null && sessionSeekDisabled) {
        log('new video source — re-enabling seek');
      }
      lastVideoSrc = currentSrc;
      sessionSeekDisabled = false;
      videoSrcChangedAt = Date.now();
    }

    if (!adapter.isAd()) {
      exitAd(video);
      return;
    }
    // 1. Try an instant skip first (e.g. YouTube "Skip Ad" button).
    if (adapter.trySkip()) return;

    // Episode-start guard: if the player hasn't buffered enough yet, neither
    // seeking nor 16x playback will work — both stall the player and the user
    // gets a stuck spinner. Wait until we have future data before doing
    // anything other than detection.
    //   readyState < HAVE_FUTURE_DATA (3) → not enough buffered to play forward
    if (video.readyState < 3) {
      log(`waiting for buffer (readyState=${video.readyState}, t=${video.currentTime.toFixed(1)})`);
      return;
    }

    // Hard timeout: if ad-state has persisted >30 real-time seconds, the
    // player is probably wedged (slow network / failed seeks / detector
    // misfire). Bail out so the user isn't stuck behind the black cover,
    // and disable seeking for the rest of this video — continuing to seek
    // after a stuck event escalates to a hard player crash.
    if (state.adEnteredAt && Date.now() - state.adEnteredAt > MAX_AD_DURATION_MS) {
      log(`ad-state stuck >${MAX_AD_DURATION_MS / 1000}s — giving up; seeks disabled for this video, fast-forward only from here`);
      sessionSeekDisabled = true;
      exitAd(video);
      return;
    }

    // Apply fast-forward + mute immediately as the safety net.
    enterAd(video);
    // Re-enforce SKIP_RATE every tick while in ad — the `seeked` handler
    // preemptively drops to 1x to avoid overshoot, and we restore it here
    // for any tick where we're still confirmed-in-ad.
    try {
      if (video.playbackRate !== SKIP_RATE) video.playbackRate = SKIP_RATE;
    } catch {}
    // Keep the cover aligned with the video on resize / fullscreen toggle.
    positionCover(video);

    // 2. Seeking — but only when safe.
    if (sessionSeekDisabled) return; // a previous break got stuck — don't retry
    if (state.seekingDisabled) return;
    if (seekInFlight) return;
    // Re-check network on each potential seek. If currently slow, disable for
    // the rest of this video — seeks here will likely crash Prime's player.
    const net = detectSlowNetwork();
    if (net.slow) {
      log(`slow network (${net.reason}) — disabling seek for this video, fast-forward only`);
      sessionSeekDisabled = true;
      return;
    }
    if (Date.now() - lastSeekedAt < POST_SEEK_GRACE_MS) return; // let player settle
    if (Date.now() - videoSrcChangedAt < SRC_CHANGE_GRACE_MS) {
      // Within episode-start grace window — fast-forward only, no seek.
      return;
    }
    if (!adapter.attemptSeek) return;

    // If we've already seeked 3+ minutes forward and we're still seeing
    // ad-state, stop seeking and let fast-forward chew through from here.
    // We deliberately DON'T snap back — that triggers a re-buffer of the
    // old position, which can wedge the player on slow networks.
    if (state.totalSeekDelta >= MAX_TOTAL_SEEK_DELTA) {
      log(`seek cap hit (+${state.totalSeekDelta}s) — disabling seek for this break, fast-forward continues`);
      state.seekingDisabled = true;
      return;
    }

    seekInFlight = true;
    const before = video.currentTime;
    adapter.attemptSeek(video);
    const delta = Math.max(0, video.currentTime - before);
    state.totalSeekDelta += delta;
    log(`seek: ${before.toFixed(1)} → ${video.currentTime.toFixed(1)} (total +${state.totalSeekDelta.toFixed(1)}s)`);
    // Hard fallback if `seeked` never fires (stalled buffer).
    setTimeout(() => { seekInFlight = false; }, SEEK_TIMEOUT_MS);
  }

  setInterval(tick, POLL_MS);

  const mo = new MutationObserver(() => tick());
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
