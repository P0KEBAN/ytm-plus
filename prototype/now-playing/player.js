(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { tracks } = window.MockData;
  const params = new URLSearchParams(location.search);
  const capture = params.get('capture') === '1';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const state = {
    trackIndex: 0, position: 140, duration: 240,
    mediaPaused: false, playing: true, buffering: false,
    volume: 42, lastNonzeroVolume: 42, muted: false, repeat: 'NONE', shuffle: false,
    lyricsStatus: 'ready', activeLine: -1, follow: true,
    translationEnabled: false, view: 'lyrics', highContrast: false, motion: true,
  };
  const lineElements = []; let offsets = [], previousFrame = null, rafId, progressAt = -Infinity;
  let layoutPending = true, seeking = false, retryTimer, seekStart = null;
  const viewport = $('lyric-viewport');
  const format = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const track = () => tracks[state.trackIndex];
  const announce = text => { $('announcement').textContent = text; };
  function palette() {
    Object.entries(track().palette).forEach(([key, value]) => document.documentElement.style.setProperty(`--art-${key}`, value));
    window.Smoke.readPalette();
  }
  function layout() {
    document.documentElement.style.setProperty('--scale', Math.min(innerWidth / 1920, innerHeight / 1080));
    layoutPending = true;
  }
  function rebuildLines() {
    const fragment = document.createDocumentFragment(); lineElements.length = 0;
    for (const line of track().lines) {
      const button = document.createElement('button'); button.className = 'lyric-line';
      const original = document.createElement('span'); original.className = 'original'; original.textContent = line.text;
      button.append(original); button.setAttribute('aria-label', [line.text, state.translationEnabled ? line.translation : '', `${format(line.at)}へ移動`].filter(Boolean).join('、'));
      if (state.translationEnabled && line.translation) {
        const translated = document.createElement('span'); translated.className = 'translation'; translated.textContent = line.translation; button.append(translated);
      }
      button.addEventListener('click', () => dispatch('seekToLyricLine', { id: line.id }));
      button.addEventListener('focus', manualFollow);
      fragment.append(button); lineElements.push(button);
    }
    $('lyric-lines').replaceChildren(fragment); state.activeLine = -1; layoutPending = true;
  }
  function renderTrack() {
    const data = track(); state.duration = data.duration;
    $('title').textContent = data.title; $('title').title = data.title;
    $('artist').textContent = data.artist; $('artist').title = data.artist;
    $('artwork').hidden = !data.artwork; $('abstract-art').hidden = !!data.artwork;
    if (data.artwork) {
      $('artwork').onerror = () => { $('artwork').hidden = true; $('abstract-art').hidden = false; };
      $('artwork').src = data.artwork; $('artwork').alt = `${data.album}のアルバムジャケット`;
    }
    $('seek').max = data.duration; $('duration').textContent = format(data.duration);
    palette(); rebuildLines(); renderQueue(); render();
  }
  function renderQueue() {
    $('queue-items').replaceChildren(...tracks.map((item, index) => {
      const button = document.createElement('button'); button.className = 'queue-item';
      button.setAttribute('aria-current', String(index === state.trackIndex));
      const title = document.createElement('strong'); title.textContent = item.title;
      const artist = document.createElement('span'); artist.textContent = `${index === state.trackIndex ? '再生中 · ' : ''}${item.artist}`;
      button.append(title, artist); button.onclick = () => dispatch('selectQueueItem', { id: item.id }); return button;
    }));
  }
  function render() {
    $('play').setAttribute('aria-label', state.buffering ? '読み込みを中止して一時停止' : state.mediaPaused ? '再生' : '一時停止');
    $('pause-icon').toggleAttribute('hidden', state.buffering || !state.playing);
    $('play-icon').toggleAttribute('hidden', state.buffering || state.playing);
    $('spinner').hidden = !state.buffering;
    $('playback-message').textContent = state.buffering ? '読み込み中…' : '';
    $('shuffle').setAttribute('aria-pressed', String(state.shuffle));
    const repeatName = { NONE: 'オフ', ALL: '全曲', ONE: '1曲' }[state.repeat];
    $('repeat').setAttribute('aria-label', `リピート：${repeatName}`);
    $('repeat').setAttribute('aria-pressed', String(state.repeat !== 'NONE'));
    document.querySelector('.repeat-one').hidden = state.repeat !== 'ONE';
    $('volume').value = state.volume; $('volume-value').value = state.volume;
    const silent = state.muted || state.volume === 0;
    $('mute').setAttribute('aria-pressed', String(silent)); $('mute').textContent = silent ? '消音を解除' : '消音';
    $('translation').checked = state.translationEnabled;
    document.body.classList.toggle('with-translation', state.translationEnabled);
    $('contrast').checked = state.highContrast; document.body.classList.toggle('high-contrast', state.highContrast);
    $('motion').checked = state.motion; window.Smoke.setMotion(state.motion);
    const showingLyrics = state.view === 'lyrics';
    document.querySelector('.right-panel').setAttribute('aria-label', showingLyrics ? '歌詞' : 'キュー');
    viewport.hidden = !showingLyrics || state.lyricsStatus !== 'ready';
    $('lyric-message').hidden = !showingLyrics || state.lyricsStatus === 'ready';
    $('lyric-message-text').textContent = { loading: '歌詞を読み込んでいます…', empty: 'この曲の歌詞はありません', error: '歌詞を読み込めませんでした' }[state.lyricsStatus] || '';
    $('retry').hidden = state.lyricsStatus !== 'error';
    $('queue-panel').hidden = showingLyrics;
    $('lyrics-view').setAttribute('aria-pressed', String(showingLyrics)); $('queue-view').setAttribute('aria-pressed', String(!showingLyrics));
    $('resume-follow').hidden = state.follow || !showingLyrics || state.lyricsStatus !== 'ready';
    updateProgress();
  }
  function updateProgress() {
    const wholeSecond = Math.round(state.position);
    if (!seeking && Number($('seek').value) !== wholeSecond) $('seek').value = wholeSecond;
    $('seek-fill').style.transform = `scaleX(${state.duration ? state.position / state.duration : 0})`;
    const elapsed = format(state.position);
    if ($('elapsed').textContent !== elapsed) $('elapsed').textContent = elapsed;
    const valueText = `${elapsed} / ${format(state.duration)}`;
    if ($('seek').getAttribute('aria-valuetext') !== valueText) $('seek').setAttribute('aria-valuetext', valueText);
  }
  function manualFollow() {
    if (!state.follow || state.lyricsStatus !== 'ready') return;
    state.follow = false; $('resume-follow').hidden = false;
  }
  function followLine(instant = false) {
    if (!state.follow || state.activeLine < 0 || viewport.hidden) return;
    const top = Math.max(0, offsets[state.activeLine] - 128);
    if (!Number.isFinite(top)) return;
    viewport.scrollTo({ top, behavior: instant || reducedMotion.matches || capture ? 'instant' : 'smooth' });
  }
  function seek(seconds) {
    state.position = Math.min(state.duration, Math.max(0, seconds));
    previousFrame = null; updateProgress();
  }
  function selectTrack(index) {
    clearTimeout(retryTimer); state.trackIndex = (index + tracks.length) % tracks.length;
    state.position = 0; state.mediaPaused = false; state.playing = true; state.buffering = false;
    state.lyricsStatus = track().lines.length ? 'ready' : 'empty'; state.follow = true;
    previousFrame = null; renderTrack(); announce(`${track().title}を再生`);
  }
  function nextIndex(direction = 1) {
    if (!state.shuffle || direction < 0) return (state.trackIndex + direction + tracks.length) % tracks.length;
    return (state.trackIndex + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length;
  }
  function dispatch(type, payload = {}) {
    // Adapter input boundary: explicit user intentions, independent of YTM internals.
    document.dispatchEvent(new CustomEvent('player-action', { detail: { type, ...payload } }));
    switch (type) {
      case 'play': if (state.position >= state.duration) seek(0); state.mediaPaused = false; state.playing = true; state.buffering = false; previousFrame = null; break;
      case 'pause': state.mediaPaused = true; state.playing = false; state.buffering = false; announce('一時停止'); break;
      case 'seek': seek(payload.seconds); break;
      case 'seekToLyricLine': { const line = track().lines.find(l => l.id === payload.id); if (line) { state.follow = true; seek(line.at); layoutPending = true; } break; }
      case 'next': selectTrack(nextIndex()); break;
      case 'previous': selectTrack(nextIndex(-1)); break;
      case 'selectQueueItem': { const index = tracks.findIndex(t => t.id === payload.id); if (index >= 0) { selectTrack(index); $('queue-items').children[index].focus(); } break; }
      case 'setVolume': state.volume = Math.max(0, Math.min(100, Math.round(payload.value))); if (state.volume > 0) { state.muted = false; state.lastNonzeroVolume = state.volume; } break;
      case 'toggleMute': if (state.volume === 0) { state.volume = state.lastNonzeroVolume; state.muted = false; } else state.muted = !state.muted; break;
      case 'toggleShuffle': state.shuffle = !state.shuffle; announce(`シャッフル${state.shuffle ? 'オン' : 'オフ'}`); break;
      case 'cycleRepeat': state.repeat = ['NONE', 'ALL', 'ONE'][(['NONE', 'ALL', 'ONE'].indexOf(state.repeat) + 1) % 3]; announce(`リピート：${{ NONE: 'オフ', ALL: '全曲', ONE: '1曲' }[state.repeat]}`); break;
      case 'setTranslationEnabled': state.translationEnabled = payload.enabled; rebuildLines(); break;
      case 'resumeLyricFollow': state.follow = true; followLine(); viewport.focus({ preventScroll: true }); break;
      case 'openQueue': state.view = 'queue'; break;
      case 'closeQueue': state.view = 'lyrics'; layoutPending = true; break;
      case 'setHighContrast': state.highContrast = payload.enabled; break;
      case 'setMotion': state.motion = payload.enabled; break;
      case 'retryLyrics': {
        clearTimeout(retryTimer); state.lyricsStatus = 'loading';
        $('lyric-message').tabIndex = -1; $('lyric-message').focus();
        retryTimer = setTimeout(() => { state.lyricsStatus = track().lines.length ? 'ready' : 'empty'; rebuildLines(); render(); if (!viewport.hidden) viewport.focus(); }, 650); break;
      }
      default: return;
    }
    render();
  }
  function scenario(name) {
    clearTimeout(retryTimer); state.trackIndex = name === 'long' ? 1 : name === 'neutral' ? 2 : 0;
    state.position = state.trackIndex === 0 ? 140 : 10;
    state.mediaPaused = name === 'paused'; state.buffering = name === 'loading';
    state.playing = !state.mediaPaused && !state.buffering;
    state.translationEnabled = name === 'translation'; state.follow = true; state.view = 'lyrics';
    state.lyricsStatus = name === 'no-lyrics' || name === 'neutral' ? 'empty' : name === 'lyrics-error' ? 'error' : name === 'lyrics-loading' ? 'loading' : 'ready';
    previousFrame = null; window.Smoke.reset(); renderTrack(); $('scenario').value = name;
  }
  $('play').onclick = () => dispatch(state.mediaPaused ? 'play' : 'pause');
  for (const [id, action] of Object.entries({ next: 'next', previous: 'previous', shuffle: 'toggleShuffle', repeat: 'cycleRepeat', mute: 'toggleMute', retry: 'retryLyrics', 'resume-follow': 'resumeLyricFollow' })) $(id).onclick = () => dispatch(action);
  $('volume').oninput = event => dispatch('setVolume', { value: Number(event.target.value) });
  $('seek').addEventListener('pointerdown', () => { seeking = true; seekStart = state.position; });
  $('seek').oninput = event => seek(Number(event.target.value));
  $('seek').onchange = event => { dispatch('seek', { seconds: Number(event.target.value) }); seeking = false; seekStart = null; };
  addEventListener('pointerup', () => { seeking = false; });
  addEventListener('pointercancel', () => { seeking = false; if (seekStart !== null) seek(seekStart); seekStart = null; });
  $('translation').onchange = event => dispatch('setTranslationEnabled', { enabled: event.target.checked });
  $('contrast').onchange = event => dispatch('setHighContrast', { enabled: event.target.checked });
  $('motion').onchange = event => dispatch('setMotion', { enabled: event.target.checked });
  $('scenario').onchange = event => scenario(event.target.value);
  $('reset').onclick = () => { Object.assign(state, { volume: 42, lastNonzeroVolume: 42, muted: false, repeat: 'NONE', shuffle: false, highContrast: false, motion: true }); scenario('playing'); $('options').close(); };
  $('more').onclick = () => $('options').showModal();
  $('close-options').onclick = () => $('options').close();
  $('options').addEventListener('close', () => $('more').focus());
  $('queue-view').onclick = () => { dispatch('openQueue'); $('queue-items').querySelector('button').focus(); };
  $('lyrics-view').onclick = () => { dispatch('closeQueue'); $('lyrics-view').focus(); };
  viewport.addEventListener('wheel', manualFollow, { passive: true });
  viewport.addEventListener('touchstart', manualFollow, { passive: true });
  viewport.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) manualFollow(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('options').open && state.view === 'queue') { dispatch('closeQueue'); $('queue-view').focus(); return; }
    if ($('options').open || event.target.closest('input, select, button, summary, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Space') { event.preventDefault(); dispatch(state.mediaPaused ? 'play' : 'pause'); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); dispatch('seek', { seconds: state.position + (event.key === 'ArrowLeft' ? -5 : 5) }); }
  });
  new ResizeObserver(() => { layoutPending = true; }).observe($('lyric-lines'));
  addEventListener('resize', layout);
  function frame(now) {
    const dt = previousFrame === null ? 0 : Math.min((now - previousFrame) / 1000, .25); previousFrame = now;
    if (!capture && !seeking && !state.mediaPaused && !state.buffering) {
      state.position = Math.min(state.duration, state.position + dt);
      if (state.position >= state.duration) {
        if (state.repeat === 'ONE') seek(0);
        else if (state.repeat === 'ALL' || state.trackIndex < tracks.length - 1) selectTrack(nextIndex());
        else { state.mediaPaused = true; state.playing = false; render(); }
      }
    }
    // Binary search reads only cached data. DOM changes only at line boundaries.
    if (state.lyricsStatus === 'ready') {
      const lines = track().lines; let low = 0, high = lines.length;
      while (low < high) { const mid = (low + high) >>> 1; if (lines[mid].at <= state.position) low = mid + 1; else high = mid; }
      const active = low - 1;
      if (active !== state.activeLine) {
        if (lineElements[state.activeLine]) { lineElements[state.activeLine].classList.remove('is-active'); lineElements[state.activeLine].removeAttribute('aria-current'); }
        state.activeLine = active;
        if (lineElements[active]) { lineElements[active].classList.add('is-active'); lineElements[active].setAttribute('aria-current', 'true'); }
        layoutPending = true;
      }
    }
    if (layoutPending && !viewport.hidden) {
      // Read offsets only after a line, font, translation, or viewport change.
      offsets = lineElements.map(el => el.offsetTop - $('lyric-lines').offsetTop);
      followLine(previousFrame === null || capture); layoutPending = false;
    }
    if (now - progressAt > 100) { updateProgress(); progressAt = now; }
    window.Smoke.tick(now); rafId = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(rafId); previousFrame = null;
    if (!document.hidden) rafId = requestAnimationFrame(frame);
  });
  layout(); scenario(params.get('state') || 'playing'); window.Smoke.init(); rafId = requestAnimationFrame(frame);
})();
