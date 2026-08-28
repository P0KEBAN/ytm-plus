  const ReplayManager = {
    HISTORY_KEY: 'ytm_local_history',
    // 再生中のレコードの更新はこちらへ書く。HISTORY_KEY は最大10,000件を保持しており、
    // chrome.storage.local はキー単位でしか書けないため、末尾1件を更新するだけでも
    // 全件の直列化が発生する。5秒おきにそれをやると履歴が伸びるほど重くなるので、
    // 進行中の値だけを単独のキーに分離している。
    // 読み出し側は loadHistory() が両者をマージした配列を返す。
    PENDING_KEY: 'ytm_local_history_pending',
    currentVideoId: null,
    hasRecordedCurrent: false,
    isRecording: false,
    currentPlayTime: 0,
    lastSaveTime: 0,
    // 進行中レコードを history 内で一意に特定するための値。recordNewPlay で設定する。
    currentRecordTimestamp: null,

    currentLyricLines: 0,
    recordedLyricLines: 0,

    formatDuration: function (seconds) {
      if (!seconds) return `0${t('unit_second')}`;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const uH = t('unit_hour');
      const uM = t('unit_minute');
      const uS = t('unit_second');
      const sp = config.uiLang === 'ja' ? '' : ' ';
      if (h > 0) return `${h}${uH}${sp}${m}${uM}${sp}${s}${uS}`;
      if (m > 0) return `${m}${uM}${sp}${s}${uS}`;
      return `${s}${uS}`;
    },

    incrementLyricCount: function () {
      this.currentLyricLines++;
    },

    // 進行中レコードを反映した履歴を返す。storage 上の HISTORY_KEY は書き換えない。
    // 履歴を読む処理は全てこれを通すこと。直接 HISTORY_KEY を読むと、再生中の曲の
    // 再生時間と歌詞行数が最後に確定した時点の値のままになる。
    loadHistory: async function () {
      const history = await storage.get(this.HISTORY_KEY) || [];
      const pending = await storage.get(this.PENDING_KEY);
      if (!pending || history.length === 0) return history;

      const lastIndex = history.length - 1;
      const last = history[lastIndex];
      if (!last || last.id !== pending.id || last.timestamp !== pending.timestamp) {
        return history;
      }

      // 受け取った配列は書き換えない。chrome.storage.local は毎回コピーを返すため
      // 実害は出ないが、そこに依存すると storage の実装を差し替えた瞬間に
      // 「読んだだけで履歴が書き換わる」壊れ方をする。
      const mergedHistory = history.slice();
      mergedHistory[lastIndex] = {
        ...last,
        duration: pending.duration,
        lyricLines: pending.lyricLines
      };
      return mergedHistory;
    },

    // 進行中レコードを history 本体へ確定させる。全件の書き戻しが発生するため、
    // 曲の切り替わりなど頻度の低いタイミングでのみ呼ぶこと。
    // 前回ブラウザが落ちて pending が残っていた場合も、次にこれが走った時点で回収される。
    flushPending: async function () {
      const pending = await storage.get(this.PENDING_KEY);
      if (!pending) return;

      const history = await storage.get(this.HISTORY_KEY) || [];
      const lastIndex = history.length - 1;
      const last = lastIndex >= 0 ? history[lastIndex] : null;
      if (last && last.id === pending.id && last.timestamp === pending.timestamp) {
        last.duration = pending.duration;
        last.lyricLines = pending.lyricLines;
        await storage.set(this.HISTORY_KEY, history);
      }
      // 対象レコードが見つからない pending は、履歴削除やインポートで整合性が
      // 失われたもの。残しても二度と確定できないので捨てる。
      await storage.remove(this.PENDING_KEY);
    },

    exportHistory: async function () {
      const history = await this.loadHistory();
      if (history.length === 0) {
        alert('保存する履歴データがありません。');
        return;
      }
      const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      a.download = `ytm_history_${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    importHistory: function () {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data)) {
              if (confirm('履歴を復元しますか？\n[OK] 現在の履歴に結合 (マージ)\n[キャンセル] キャンセル')) {
                // 進行中レコードを先に確定させる。これをしないと、マージ後の履歴に対して
                // 古い pending が残り、末尾レコードの照合に失敗して破棄されてしまう。
                await this.flushPending();
                const current = await storage.get(this.HISTORY_KEY) || [];
                const existingIds = new Set(current.map(i => i.id + '_' + i.timestamp));
                const newData = data.filter(i => !existingIds.has(i.id + '_' + i.timestamp));
                const merged = current.concat(newData);
                merged.sort((a, b) => a.timestamp - b.timestamp);
                await storage.set(this.HISTORY_KEY, merged);
                alert('履歴を復元しました！');
                this.renderUI();
              }
            } else {
              alert('無効なファイル形式です。');
            }
          } catch (err) {
            console.error(err);
            alert('ファイルの読み込みに失敗しました。');
          }
        };
        reader.readAsText(file);
      };
      input.click();
    },

    check: async function () {
      const video = document.querySelector('video');
      if (!video) return;
      const vid = getCurrentVideoId();
      if (!vid) return;

      if (vid !== this.currentVideoId) {
        this.currentVideoId = vid;
        this.hasRecordedCurrent = false;
        this.isRecording = false;
        this.currentPlayTime = 0;
        this.lastSaveTime = 0;
        this.currentLyricLines = 0;
        this.recordedLyricLines = 0;
        this.currentRecordTimestamp = null;
        // 前の曲の再生時間をここで履歴へ確定させる。全件書き戻しはこのタイミングと
        // recordNewPlay のときだけ発生する。
        await this.flushPending();
        return;
      }

      if (!video.paused) {
        this.currentPlayTime++;
        const isPlayed = this.currentPlayTime > 30 || (video.duration > 10 && this.currentPlayTime / video.duration > 0.4);

        if (isPlayed) {
          if (!this.hasRecordedCurrent && !this.isRecording) {
            this.isRecording = true;
            try {
              await this.recordNewPlay();
              this.hasRecordedCurrent = true;
            } finally {
              this.isRecording = false;
            }
          } else if (this.currentPlayTime - this.lastSaveTime >= 5 && !this.isRecording) {
            this.isRecording = true;
            try {
              await this.updateDuration();
              this.lastSaveTime = this.currentPlayTime;
            } finally {
              this.isRecording = false;
            }
          }
        }
      }
    },

    recordNewPlay: async function () {
      const meta = getMetadata();
      if (!meta) return;

      this.recordedLyricLines = this.currentLyricLines;

      const record = {
        id: this.currentVideoId,
        title: meta.title,
        artist: meta.artist,
        src: meta.src,
        duration: this.currentPlayTime,
        lyricLines: this.currentLyricLines,
        timestamp: Date.now()
      };

      // 直前の曲の pending が残っていれば、この曲を push する前に確定させる。
      // 先に push すると末尾が入れ替わり、pending の照合先を失う。
      await this.flushPending();

      let history = await storage.get(this.HISTORY_KEY) || [];
      if (history.length > 10000) history = history.slice(-10000);
      history.push(record);
      await storage.set(this.HISTORY_KEY, history);
      this.currentRecordTimestamp = record.timestamp;

      if (ui.replayPanel && ui.replayPanel.classList.contains('active')) {
        this.renderUI();
      }
    },

    // 再生中に5秒おきに呼ばれる。以前はここで履歴を全件読み書きしていたため、
    // 履歴が伸びるほど再生中ずっと重くなっていた。書き込み先を単独キーへ分離し、
    // 履歴サイズによらず一定コストで済むようにしている。
    updateDuration: async function () {
      if (!this.currentRecordTimestamp) return;

      await storage.set(this.PENDING_KEY, {
        id: this.currentVideoId,
        timestamp: this.currentRecordTimestamp,
        duration: this.currentPlayTime,
        lyricLines: this.currentLyricLines
      });

      if (ui.replayPanel && ui.replayPanel.classList.contains('active')) {
        this.renderUI();
      }
    },

    getStats: async function (range = 'day') {
      const history = await this.loadHistory();
      const now = Date.now();
      let threshold = 0;
      if (range === 'day') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        threshold = today.getTime();
      } else if (range === 'week') {
        threshold = now - (7 * 24 * 60 * 60 * 1000);
      }

      const filtered = history.filter(h => h.timestamp >= threshold);

      const countMap = {};
      const artistMap = {};
      const uniqueArtists = new Set();
      let totalSeconds = 0;
      let totalLyrics = 0;
      const hourCounts = new Array(24).fill(0);

      filtered.forEach(h => {
        const key = h.title + '///' + h.artist;
        if (!countMap[key]) countMap[key] = { ...h, count: 0, totalDuration: 0 };

        countMap[key].count++;
        const duration = typeof h.duration === 'number' ? h.duration : 0;
        countMap[key].totalDuration += duration;

        if (!artistMap[h.artist]) {
          artistMap[h.artist] = { count: 0, src: h.src };
        } else {
          artistMap[h.artist].count++;
          if (h.src) artistMap[h.artist].src = h.src;
        }

        uniqueArtists.add(h.artist);
        totalSeconds += duration;

        if (h.lyricLines && typeof h.lyricLines === 'number') {
          totalLyrics += h.lyricLines;
        }

        const hour = new Date(h.timestamp).getHours();
        hourCounts[hour]++;
      });

      const topSongs = Object.values(countMap).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.totalDuration - a.totalDuration;
      });

      const topArtists = Object.keys(artistMap)
        .map(name => ({
          name,
          count: artistMap[name].count,
          src: artistMap[name].src
        }))
        .sort((a, b) => b.count - a.count);

      const mostPlayedArtist = topArtists[0] || null;
      const mostPlayedSong = topSongs[0] || null;

      const totalPlays = filtered.length;
      const maxHourVal = Math.max(...hourCounts);
      const peakHour = hourCounts.indexOf(maxHourVal);
      const totalHours = totalSeconds / 3600;
      const today = new Date(Date.now());
      const dayOfWeek = today.getDay();

      let vibeLabel = "分  中...";
      let topArtistShare = "0%";

      if (totalPlays > 0) {
        const topArtistRatio = mostPlayedArtist ? (mostPlayedArtist.count / totalPlays) : 0;
        const topSongRatio = mostPlayedSong ? (mostPlayedSong.count / totalPlays) : 0;
        const diversityRatio = uniqueArtists.size / totalPlays;

        topArtistShare = Math.round(topArtistRatio * 100) + "%";

        if (totalPlays < 5) {
          vibeLabel = "音楽探しの途中";
        }
        else if (topArtistRatio >= 0.6) {
          vibeLabel = `${mostPlayedArtist.name} 一筋`;
        }
        else if (topSongRatio >= 0.5) {
          vibeLabel = "一点集中リピート";
        }
        else if (diversityRatio >= 0.8) {
          vibeLabel = "幅広く開拓中";
        }
        else if (totalHours >= 4) {
          vibeLabel = "耐久リスニングマスター";
        }
        else if (dayOfWeek === 5) {
          vibeLabel = "💃 解放のフライデー";
        }
        else if (dayOfWeek === 6) {
          vibeLabel = "🥳 週末お祭りモード";
        }
        else if (dayOfWeek === 0) {
          vibeLabel = "🧘‍♂️ 明日への充電";
        }
        else {
          if (peakHour >= 4 && peakHour < 9) { vibeLabel = "早起きスタイル"; }
          else if (peakHour >= 9 && peakHour < 12) { vibeLabel = "午前中の集中"; }
          else if (peakHour >= 12 && peakHour < 17) { vibeLabel = "午後ワーク"; }
          else if (peakHour >= 17 && peakHour < 23) { vibeLabel = "夜型リスナー"; }
          else { vibeLabel = "深夜の没頭"; }
        }
      } else {
        vibeLabel = "No Data";
      }

      return {
        totalPlays,
        totalTime: this.formatDuration(totalSeconds),
        totalLyrics: totalLyrics.toLocaleString(),
        vibeLabel,
        topArtistShare,
        peakHour,
        topSongs: topSongs.slice(0, 50),
        topArtists: topArtists.slice(0, 10),
        mostPlayedSong,
        mostPlayedArtist
      };
    },

    renderUI: async function () {
      if (!ui.replayPanel) return;
      const container = ui.replayPanel.querySelector('.ytm-replay-content');

      const range = ui.replayPanel.dataset.range || 'day';
      const stats = await this.getStats(range);

      const pills = ui.replayPanel.querySelectorAll('.ytm-lang-pill');
      if (pills[0]) pills[0].textContent = t('replay_today');
      if (pills[1]) pills[1].textContent = t('replay_week');
      if (pills[2]) pills[2].textContent = t('replay_all');

      let footerArea = document.getElementById('replay-footer-area');

      const oldBtn1 = document.getElementById('replay-reset-action');
      const oldBtn2 = document.getElementById('replay-export-btn');
      const oldBtn3 = document.getElementById('replay-import-btn');
      if (oldBtn1 && !oldBtn1.closest('.replay-footer-area')) oldBtn1.remove();
      if (oldBtn2) oldBtn2.remove();
      if (oldBtn3) oldBtn3.remove();

      if (!footerArea) {
        footerArea = createEl('div', 'replay-footer-area', 'replay-footer-area');
        ui.replayPanel.appendChild(footerArea);
      }

      footerArea.innerHTML = `
        <button id="replay-import-btn" class="replay-footer-btn">📂 Restore</button>
        <button id="replay-export-btn" class="replay-footer-btn">💾 Backup</button>
        <button id="replay-cloudsync-btn" class="replay-footer-btn">☁ Cloud</button>
        <button id="replay-reset-action" class="replay-footer-btn" style="color:#ff6b6b; border-color:rgba(255,107,107,0.3);">🗑️ Reset</button>
      `;

      document.getElementById('replay-reset-action').onclick = async () => {
        if (confirm(t('replay_reset_confirm'))) {
          await storage.remove(ReplayManager.HISTORY_KEY);
          // 進行中レコードも一緒に消す。残すと照合先を失った pending がゴミとして居座る。
          await storage.remove(ReplayManager.PENDING_KEY);
          ReplayManager.renderUI();
        }
      };
      document.getElementById('replay-export-btn').onclick = () => this.exportHistory();
      document.getElementById('replay-import-btn').onclick = () => this.importHistory();

      const cloudBtn = document.getElementById('replay-cloudsync-btn');
      if (cloudBtn) {
        cloudBtn.onclick = () => {
          CloudSync.init();
          if (CloudSync.openPanel) {
            CloudSync.openPanel();
          }
        };
      }


      document.getElementById('replay-reset-action').onclick = async () => {
        if (confirm(t('replay_reset_confirm'))) {
          await storage.remove(ReplayManager.HISTORY_KEY);
          // 進行中レコードも一緒に消す。残すと照合先を失った pending がゴミとして居座る。
          await storage.remove(ReplayManager.PENDING_KEY);
          ReplayManager.renderUI();
        }
      };
      document.getElementById('replay-export-btn').onclick = () => this.exportHistory();
      document.getElementById('replay-import-btn').onclick = () => this.importHistory();

      if (stats.totalPlays === 0) {
        container.innerHTML = `<div class="replay-empty"><div style="font-size:40px; margin-bottom:10px;">🎧</div><div>${t('replay_empty')}</div><div style="font-size:12px; opacity:0.6; margin-top:5px;">${t('replay_no_data_sub')}</div></div>`;
        return;
      }

      const heroImage = stats.mostPlayedSong?.src || '';

      const artistBgStyle = `background: linear-gradient(135deg, rgba(50,100,255,0.1), rgba(255,255,255,0.03));`;

      let topArtistsSubHtml = '';
      if (stats.topArtists.length > 1) {
        topArtistsSubHtml = `<div style="margin-top:auto; padding-top:10px; border-top:1px solid rgba(255,255,255,0.1); font-size:12px; font-weight:600; color:rgba(255,255,255,0.9);">`;
        if (stats.topArtists[1]) topArtistsSubHtml += `<div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:center;"><span style="opacity:0.9;">#2 ${stats.topArtists[1].name}</span><span style="opacity:0.7;">${stats.topArtists[1].count}回</span></div>`;
        if (stats.topArtists[2]) topArtistsSubHtml += `<div style="display:flex; justify-content:space-between; align-items:center;"><span style="opacity:0.9;">#3 ${stats.topArtists[2].name}</span><span style="opacity:0.7;">${stats.topArtists[2].count}回</span></div>`;
        topArtistsSubHtml += `</div>`;
      }

      let html = `
        <div class="bento-grid">
          
          <div class="bento-item hero-stat-time">
            <div class="bento-label">${t('replay_playTime')}</div>
            <div class="bento-value-huge">${stats.totalTime}</div>
            <div class="bento-sub">${stats.totalPlays} ${t('replay_plays')}</div>
          </div>

          <div class="bento-item hero-song" style="background-image: url('${heroImage}');">
            <div class="bento-overlay">
              <div class="bento-label">${t('replay_topSong')}</div>
              <div class="bento-song-title">${stats.mostPlayedSong?.title}</div>
              <div class="bento-song-artist">${stats.mostPlayedSong?.artist}</div>
              <div class="bento-badge">${stats.mostPlayedSong?.count} ${t('replay_plays')}</div>
            </div>
          </div>

          <div class="bento-item hero-vibe">
            <div class="bento-label">${t('replay_vibe')}</div>
            <div class="bento-vibe-text" style="font-size:24px; font-weight:900; margin-top:10px; line-height:1.2; word-break:break-all;">${stats.vibeLabel}</div>
          </div>

          <div class="bento-item hero-lyrics">
            <div class="bento-label">${t('replay_lyrics_heard')}</div>
            <div class="bento-value-huge" style="font-size: 42px;">${stats.totalLyrics}</div>
            <div class="bento-sub">行</div>
          </div>

          <div class="bento-item hero-artist" style="${artistBgStyle} position:relative; overflow:hidden;">
            <div style="position:relative; z-index:2; height:100%; display:flex; flex-direction:column; color:#fff; padding-bottom:5px;">
              <div class="bento-label" style="color:rgba(255,255,255,0.7);">${t('replay_topArtist')}</div>
              
              <div class="bento-artist-name" style="font-size:28px; font-weight:900; margin: 5px 0 10px 0; color:#fff; line-height:1.1; flex-shrink: 0; min-height: 30px;">
                ${stats.mostPlayedArtist?.name || 'N/A'}
              </div>
              
              <div class="bento-badge" style="font-size:11px; padding:4px 10px; margin-bottom:10px; align-self:flex-start; background:rgba(255,255,255,0.25); border:1px solid rgba(255,255,255,0.1);">
                総再生の ${stats.topArtistShare}
              </div>

              ${topArtistsSubHtml}
            </div>
          </div>

          <div class="bento-item ranking-list-container">
            <div class="bento-label">${t('replay_ranking')}</div>
            <div class="replay-list">`;

      stats.topSongs.forEach((song, idx) => {
        const timeStr = this.formatDuration(song.totalDuration);
        html += `
          <div class="replay-item">
            <div class="replay-rank">${idx + 1}</div>
            <div class="replay-img">${song.src ? `<img src="${song.src}" crossorigin="anonymous">` : ''}</div>
            <div class="replay-info">
              <div class="replay-title">${song.title}</div>
              <div class="replay-artist">${song.artist}</div>
            </div>
            <div class="replay-count">
              <div class="replay-count-val">${song.count}${config.uiLang === 'ja' ? '回' : ''}</div>
              <div class="replay-time-val">${timeStr}</div>
            </div>
          </div>`;
      });
      html += `</div></div></div>`;
      container.innerHTML = html;
    },

    init: function () {
      setInterval(() => this.check(), 1000);
    }
  };


