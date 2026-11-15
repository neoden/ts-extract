const YOUTUBE_RE = /^https:\/\/([a-z]+\.)?youtube\.com\//;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !YOUTUBE_RE.test(tab.url ?? '')) {
    flashBadge(tab.id, '✗');
    return;
  }

  let result;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // needs the page's player object
      func: extractTranscript,
    });
    result = injection?.result ?? { error: 'Скрипт ничего не вернул' };
  } catch (e) {
    result = { error: String(e?.message ?? e) };
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: copyAndNotify,
      args: [result],
    });
    flashBadge(tab.id, injection?.result ? '✓' : '✗');
  } catch {
    flashBadge(tab.id, '✗');
  }
});

function flashBadge(tabId, text) {
  if (!tabId) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: text === '✓' ? '#1a7f37' : '#cf222e' });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

// ---------------------------------------------------------------------------
// Runs in the page (MAIN world). Must be self-contained.
// Returns { text, source, lang } or { error }.
// ---------------------------------------------------------------------------
async function extractTranscript() {
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  // Glue caption segments into paragraphs: break after a sentence end once the
  // paragraph is long enough, or unconditionally if it grows too long
  // (auto-captions often have no punctuation at all).
  const toParagraphs = (parts) => {
    const paragraphs = [];
    let current = '';
    for (const part of parts.map(clean).filter(Boolean)) {
      current = current ? `${current} ${part}` : part;
      if ((current.length >= 300 && /[.!?…]["»”)]?$/.test(current)) || current.length >= 700) {
        paragraphs.push(current);
        current = '';
      }
    }
    if (current) paragraphs.push(current);
    return paragraphs.join('\n\n');
  };

  const fetchTrack = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const body = await res.text();
      if (!body) return null; // YouTube answers 200 + empty body when it wants a PO token
      const events = JSON.parse(body).events ?? [];
      const text = toParagraphs(
        events.filter((ev) => ev.segs).map((ev) => ev.segs.map((s) => s.utf8 ?? '').join(''))
      );
      return text || null;
    } catch {
      return null;
    }
  };

  const fromTimedtext = async () => {
    const player = document.getElementById('movie_player');
    const response = player?.getPlayerResponse?.();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;

    // The auto-generated track tells us the spoken language; prefer a
    // human-made track in that language, then the auto one, then anything.
    const asr = tracks.find((t) => t.kind === 'asr');
    const track =
      tracks.find((t) => t.kind !== 'asr' && t.languageCode === asr?.languageCode) ??
      asr ??
      tracks[0];

    const url = new URL(track.baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');

    let text = await fetchTrack(url);
    if (!text) {
      // If the player itself already loaded captions (CC was on), reuse its PO token.
      const videoId = response?.videoDetails?.videoId;
      const seen = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/api/timedtext') && n.includes('pot=') && (!videoId || n.includes(videoId)))
        .pop();
      if (seen) {
        const seenParams = new URL(seen).searchParams;
        for (const key of ['pot', 'potc', 'c', 'cver', 'cplayer']) {
          const value = seenParams.get(key);
          if (value) url.searchParams.set(key, value);
        }
        text = await fetchTrack(url);
      }
    }
    return text ? { text, source: 'timedtext', lang: track.languageCode } : null;
  };

  const fromPanel = async () => {
    const PANEL = 'ytd-engagement-panel-section-list-renderer';
    // transcript-segment-view-model is the current markup, ytd-transcript-segment-renderer the old one.
    const SEGMENTS =
      `${PANEL}[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] ` +
      ':is(transcript-segment-view-model, ytd-transcript-segment-renderer)';
    const OPEN_BUTTON = 'ytd-video-description-transcript-section-renderer button';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (probe, timeout) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = probe();
        if (value || Date.now() >= deadline) return value;
        await sleep(150);
      }
    };
    const count = () => document.querySelectorAll(SEGMENTS).length;

    let openedByUs = false;
    if (!count()) {
      // The description block (and its button) renders a few seconds after page load.
      const button = await waitFor(() => document.querySelector(OPEN_BUTTON), 5000);
      if (!button) return null;
      button.click();
      openedByUs = true;
    }

    await waitFor(count, 8000);
    // Let the list finish rendering: wait until the segment count stops growing.
    for (let prev = -1, cur = count(); cur !== prev; prev = cur, cur = count()) {
      await sleep(300);
    }

    const segments = [...document.querySelectorAll(SEGMENTS)];
    const text = toParagraphs(
      segments.map((seg) => {
        const copy = seg.cloneNode(true);
        copy.querySelectorAll('[class*="Timestamp"], .segment-timestamp').forEach((el) => el.remove());
        return copy.textContent;
      })
    );

    if (openedByUs) {
      segments[0]?.closest(PANEL)?.querySelector('#visibility-button button')?.click();
    }
    return text ? { text, source: 'panel' } : null;
  };

  try {
    return (
      (await fromTimedtext()) ??
      (await fromPanel()) ?? { error: 'Транскрипт не найден — похоже, у видео нет субтитров' }
    );
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Runs in the page (isolated world): copies the text and shows a toast.
// Returns true if the text ended up in the clipboard.
// ---------------------------------------------------------------------------
async function copyAndNotify(result) {
  const toast = (message, ok) => {
    document.getElementById('__yt_transcript_toast')?.remove();
    const el = document.createElement('div');
    el.id = '__yt_transcript_toast';
    el.textContent = message;
    el.style.cssText = [
      'position:fixed', 'top:72px', 'right:24px', 'z-index:2147483647',
      'max-width:360px', 'padding:12px 16px', 'border-radius:8px',
      'font:14px/1.4 Roboto,Arial,sans-serif', 'color:#fff',
      `background:${ok ? '#1a7f37' : '#cf222e'}`,
      'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    ].join(';');
    (document.fullscreenElement ?? document.body).appendChild(el);
    setTimeout(() => el.remove(), 3000);
  };

  if (!result?.text) {
    toast(result?.error ?? 'Не удалось получить транскрипт', false);
    return false;
  }

  let copied = false;
  try {
    await navigator.clipboard.writeText(result.text);
    copied = true;
  } catch {
    // Page not focused, etc. — fall back to the legacy path (clipboardWrite permission).
    const ta = document.createElement('textarea');
    ta.value = result.text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    copied = document.execCommand('copy');
    ta.remove();
  }

  toast(
    copied
      ? `Транскрипт скопирован: ${result.text.length.toLocaleString('ru-RU')} символов`
      : 'Транскрипт получен, но скопировать в буфер не удалось',
    copied
  );
  return copied;
}
