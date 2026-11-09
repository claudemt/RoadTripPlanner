(function () {
  const {escapeHtml} = window.HtmlUtils;
  const {formatClock} = window.FormatUtils;
  const FALLBACK_MAX = 30 * 1024 * 1024;
  const DEFAULT_VOLUME = 0.6;
  const READY_HINT = 'MP3 · 单个 ≤30MB';

  function create({el, localService, dialogs, toast, confirmDialog}) {
    const checkbox = el('exportMusicEnabled');
    const pickBtn = el('exportMusicPickBtn');
    const summaryEl = el('exportMusicSummary');
    const listEl = el('exportMusicList');
    const uploadBtn = el('exportMusicUploadBtn');
    const fileInput = el('exportMusicFile');
    const statusEl = el('exportMusicStatus');
    const volumeInput = el('exportMusicVolume');
    const volumeValueEl = el('exportMusicVolumeValue');
    const closeBtn = el('exportMusicCloseBtn');

    let tracks = [];
    let selectedId = '';
    let volume = DEFAULT_VOLUME;
    let routeId = '';
    let prepareToken = 0;
    let audio = null;
    let playingId = '';
    let maxBytes = FALLBACK_MAX;
    let loading = false;
    let touched = false;
    let loadFailed = false;
    let pending = Promise.resolve();

    const streamUrl = (id) => (typeof localService.musicStreamUrl === 'function'
      ? localService.musicStreamUrl(id)
      : `/api/v1/music/stream?id=${encodeURIComponent(id)}`);

    const selectedTrack = () => tracks.find((track) => track.id === selectedId) || null;

    function setStatus(message, isError = false) {
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.classList.toggle('is-error', Boolean(isError));
    }

    function renderSummary() {
      renderPickerAction();
      if (!summaryEl) return;
      if (!routeId) {
        summaryEl.textContent = '保存路线后可选';
        return;
      }
      if (!checkbox?.checked) {
        summaryEl.textContent = loadFailed ? '读取失败' : '不添加';
        return;
      }
      const track = selectedTrack();
      summaryEl.textContent = track ? track.title : '未选择';
    }

    function renderPickerAction() {
      if (closeBtn) closeBtn.textContent = selectedId ? '确定' : '关闭';
    }

    function renderVolume() {
      if (volumeInput) volumeInput.value = String(Math.round(volume * 100));
      if (volumeValueEl) volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
      if (audio) audio.volume = volume;
    }

    function updatePlayButtons() {
      if (!listEl) return;
      listEl.querySelectorAll('[data-play]').forEach((button) => {
        const active = button.dataset.play === playingId;
        button.textContent = active ? '暂停' : '试听';
        button.classList.toggle('is-playing', active);
      });
    }

    function stopPreview() {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      playingId = '';
      updatePlayButtons();
    }

    function togglePreview(id) {
      if (!audio) {
        audio = new Audio();
        audio.preload = 'none';
        audio.addEventListener('ended', () => {
          playingId = '';
          updatePlayButtons();
        });
      }
      if (playingId === id) {
        stopPreview();
        return;
      }
      audio.pause();
      audio.src = streamUrl(id);
      audio.volume = volume;
      playingId = id;
      updatePlayButtons();
      const play = audio.play();
      if (play && typeof play.catch === 'function') {
        play.catch(() => {
          playingId = '';
          updatePlayButtons();
          toast && toast('试听失败');
        });
      }
    }

    function renderList() {
      if (!listEl) return;
      if (loading) {
        listEl.innerHTML = '<div class="music-empty">读取中…</div>';
        return;
      }
      if (!tracks.length) {
        listEl.innerHTML = '<div class="music-empty">暂无音乐</div>';
        return;
      }
      listEl.innerHTML = tracks.map((track) => `
        <div class="music-row${track.id === selectedId ? ' is-selected' : ''}" data-id="${escapeHtml(track.id)}" role="button" tabindex="0">
          <button class="music-play" type="button" data-play="${escapeHtml(track.id)}">试听</button>
          <div class="music-meta">
            <div class="music-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
            <div class="music-sub">${track.source === 'default' ? '内置' : '已上传'} · ${formatClock(track.durationSec)}</div>
          </div>
          ${track.source === 'default' ? '' : `<button class="music-delete" type="button" data-delete="${escapeHtml(track.id)}">删除</button>`}
        </div>
      `).join('');
      updatePlayButtons();
    }

    async function loadLibrary(force = false) {
      if (tracks.length && !force) return tracks;
      loading = true;
      renderList();
      try {
        const {response, data} = await localService.musicLibrary();
        if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取音乐列表');
        tracks = Array.isArray(data.tracks) ? data.tracks : [];
        if (Number(data.maxUploadBytes) > 0) maxBytes = Number(data.maxUploadBytes);
        return tracks;
      } finally {
        loading = false;
        renderList();
      }
    }

    function persist() {
      if (!routeId || typeof localService.saveRouteMusic !== 'function') return Promise.resolve();
      return localService.saveRouteMusic(routeId, {
        enabled: Boolean(checkbox?.checked),
        trackId: selectedId || '',
        volume
      }).catch(() => null);
    }

    function prepare(id) {
      routeId = String(id || '');
      prepareToken += 1;
      const token = prepareToken;
      touched = false;
      loadFailed = false;
      selectedId = '';
      volume = DEFAULT_VOLUME;
      if (checkbox) checkbox.checked = false;
      renderVolume();
      renderSummary();
      stopPreview();
      pending = (async () => {
        if (!routeId) return;
        try {
          await loadLibrary(true);
          if (token !== prepareToken) return;
          const {data} = await localService.getRouteMusic(routeId);
          if (token !== prepareToken) return;
          const saved = data?.selection || null;
          if (!touched && saved?.trackId && tracks.some((track) => track.id === saved.trackId)) {
            selectedId = saved.trackId;
            volume = Number.isFinite(Number(saved.volume)) ? Number(saved.volume) : DEFAULT_VOLUME;
            if (checkbox) checkbox.checked = saved.enabled !== false;
            renderVolume();
          }
          renderSummary();
          if (listEl && listEl.closest('.modal.open')) renderList();
        } catch (error) {
          if (token !== prepareToken) return;
          loadFailed = true;
          renderSummary();
        }
      })();
      return pending;
    }

    async function openPicker() {
      stopPreview();
      setStatus('');
      if (dialogs) dialogs.open('exportMusicModal');
      try {
        await loadLibrary(true);
        setStatus(READY_HINT);
      } catch (error) {
        setStatus(error.message || '读取失败', true);
      }
    }

    function selectTrack(id) {
      if (!tracks.some((track) => track.id === id)) return;
      touched = true;
      selectedId = id;
      if (checkbox) checkbox.checked = true;
      renderList();
      renderSummary();
      persist();
    }

    async function removeTrack(id) {
      const track = tracks.find((item) => item.id === id);
      if (!track) return;
      const ok = confirmDialog
        ? await confirmDialog({title: '删除音乐', message: `「${track.title}」`, compact: true, okText: '删除'})
        : true;
      if (!ok) return;
      try {
        const {response, data} = await localService.deleteMusicTrack(id);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '删除失败');
        tracks = tracks.filter((item) => item.id !== id);
        if (selectedId === id) {
          selectedId = '';
          if (checkbox) checkbox.checked = false;
        }
        if (playingId === id) stopPreview();
        renderList();
        renderSummary();
        setStatus(READY_HINT);
        persist();
      } catch (error) {
        setStatus(error.message || '删除失败', true);
      }
    }

    async function uploadFiles(fileList) {
      const files = [...(fileList || [])].filter((file) => file);
      if (!files.length) return;
      for (const file of files) {
        if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') {
          toast && toast(`「${file.name}」不是 MP3`);
          continue;
        }
        if (file.size > maxBytes) {
          toast && toast(`「${file.name}」超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
          continue;
        }
        try {
          setStatus('上传中 0%');
          const {response, data} = await localService.uploadMusic(file, (loaded, total) => {
            const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setStatus(`上传中 ${percent}%`);
          });
          if (!response.ok || !data?.ok) throw new Error(data?.message || '上传失败');
          tracks.push(data.track);
          touched = true;
          selectedId = data.track.id;
          if (checkbox) checkbox.checked = true;
          renderList();
          renderSummary();
          setStatus(READY_HINT);
          persist();
        } catch (error) {
          setStatus(error.message || '上传失败', true);
          toast && toast(error.message || '上传失败');
        }
      }
    }

    function getSelection() {
      if (!checkbox?.checked || !selectedId) return null;
      return {enabled: true, trackId: selectedId, volume};
    }

    async function getSelectionAsync() {
      try {
        await pending;
      } catch (_) {
      }
      return getSelection();
    }

    function bind() {
      if (checkbox) {
        checkbox.onchange = () => {
          touched = true;
          renderSummary();
          if (checkbox.checked) {
            if (!selectedId) openPicker();
            else persist();
          } else {
            stopPreview();
            persist();
          }
        };
      }
      if (pickBtn) pickBtn.onclick = () => openPicker();
      if (volumeInput) {
        volumeInput.oninput = () => {
          touched = true;
          volume = Math.max(0, Math.min(1, Number(volumeInput.value) / 100));
          renderVolume();
          renderSummary();
        };
        volumeInput.onchange = () => persist();
      }
      if (uploadBtn && fileInput) {
        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = () => {
          const files = fileInput.files;
          fileInput.value = '';
          uploadFiles(files);
        };
      }
      if (listEl) {
        listEl.addEventListener('click', (event) => {
          const playButton = event.target.closest('[data-play]');
          if (playButton) {
            event.stopPropagation();
            togglePreview(playButton.dataset.play);
            return;
          }
          const deleteButton = event.target.closest('[data-delete]');
          if (deleteButton) {
            event.stopPropagation();
            removeTrack(deleteButton.dataset.delete);
            return;
          }
          const row = event.target.closest('.music-row');
          if (row) selectTrack(row.dataset.id);
        });
        listEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.target.closest('button')) return;
          const row = event.target.closest('.music-row');
          if (!row) return;
          event.preventDefault();
          selectTrack(row.dataset.id);
        });
      }
      if (dialogs) {
        dialogs.register('exportMusicModal', () => {
          stopPreview();
          if (checkbox?.checked && !selectedId) {
            checkbox.checked = false;
            renderSummary();
            persist();
          }
          el('exportMusicModal')?.classList.remove('open');
        });
      }
      renderVolume();
      renderSummary();
    }

    async function resolve(id) {
      await prepare(id);
      return getSelection();
    }

    bind();

    return {prepare, resolve, getSelectionAsync};
  }

  window.ExportMusicUi = {create};
})();
