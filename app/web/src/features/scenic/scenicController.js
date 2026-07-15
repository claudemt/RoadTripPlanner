(function () {
  function create({
    el,
    localService,
    normalizeSpotName,
    escapeHtml,
    escapeAttr,
    escapeJsAttr,
    toast
  }) {
    const loadedFolders = {};
    let openedAt = 0;

    function updateImageList() {
      const files = [...(el('pointScenicImages').files || [])];
      el('pointScenicImageList').textContent = files.length
        ? files.map((file) => file.name).join('；')
        : '未选择图片';
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
    }

    async function saveFromEditor(point) {
      const description = el('pointScenicDescription').value.trim();
      const files = [...(el('pointScenicImages').files || [])];
      if (!description && !files.length) return null;
      if (files.length > 6) throw new Error('每次最多上传 6 张图片');
      const invalid = files.find((file) => !file.type.startsWith('image/') || file.size > 8 * 1024 * 1024);
      if (invalid) throw new Error('图片必须小于 8MB，且使用常见图片格式');
      const images = [];
      for (const file of files) {
        images.push({name: file.name, dataUrl: await readFileAsDataUrl(file)});
      }
      const {response, data: result} = await localService.saveScenic({
        name: point.name,
        title: point.name,
        description,
        images
      });
      if (!response.ok || !result.ok) throw new Error(result.message || '保存景点介绍失败');
      window.SCENIC_SPOTS = (window.SCENIC_SPOTS || [])
        .filter((spot) => normalizeSpotName(spot.name || spot.title) !== normalizeSpotName(point.name));
      window.SCENIC_SPOTS.push(result.spot);
      loadedFolders[result.folderName] = Promise.resolve();
      return result;
    }

    function findInfo(name) {
      const target = normalizeSpotName(name);
      if (!target || !Array.isArray(window.SCENIC_SPOTS)) return null;
      return window.SCENIC_SPOTS.find((spot) => {
        return [spot.name, spot.title].some((alias) => {
          const normalized = normalizeSpotName(alias);
          return normalized && target === normalized;
        });
      }) || null;
    }

    function folderCandidates(name) {
      const raw = String(name || '').replace(/（.*?）|\(.*?\)/g, '').trim();
      const normalized = normalizeSpotName(raw);
      return [...new Set([raw, normalized].filter(Boolean))];
    }

    function scriptUrl(folder) {
      const encoded = String(folder).split('/').map(encodeURIComponent).join('/');
      return `scene/${encoded}/${encoded}.js`;
    }

    function loadFolder(folder) {
      if (loadedFolders[folder]) return loadedFolders[folder];
      loadedFolders[folder] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptUrl(folder);
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('missing'));
        document.head.appendChild(script);
      });
      return loadedFolders[folder];
    }

    async function ensureInfo(name) {
      let found = findInfo(name);
      if (found) return found;
      if (typeof localService.getScenic === 'function') {
        try {
          const {response, data} = await localService.getScenic(name);
          if (response.ok && data?.spot) {
            window.SCENIC_SPOTS = (window.SCENIC_SPOTS || [])
              .filter((spot) => normalizeSpotName(spot.name || spot.title) !== normalizeSpotName(name));
            window.SCENIC_SPOTS.push(data.spot);
            return data.spot;
          }
        } catch (_) {}
      }
      for (const folder of folderCandidates(name)) {
        try {
          await loadFolder(folder);
          found = findInfo(name);
          if (found) return found;
        } catch (_) {}
      }
      return null;
    }

    async function showSpotInfo(name) {
      const spot = await ensureInfo(name);
      if (!spot) return toast('暂时没有这个地点的图文介绍。');
      el('spotTitle').textContent = spot.title;
      const images = (spot.images || []).map((source) => {
        return `<img src="${escapeAttr(source)}" alt="${escapeAttr(spot.title)}" onclick="openLightbox('${escapeJsAttr(source)}')">`;
      }).join('');
      el('spotBody').innerHTML = `
        <div class="spot-images">${images}</div>
        <div class="spot-text">${escapeHtml(spot.description || '暂无介绍')}</div>
      `;
      openedAt = Date.now();
      el('spotPanel').classList.add('open');
    }

    function openLightbox(source) {
      el('lightboxImage').src = source;
      el('imageLightbox').classList.add('open');
    }

    function closeSpotPanel() {
      el('spotPanel').classList.remove('open');
    }

    function closeLightbox() {
      el('imageLightbox').classList.remove('open');
    }

    function handleOutsideClick(target) {
      if (
        el('spotPanel').classList.contains('open') &&
        Date.now() - openedAt > 80 &&
        !target.closest('#spotPanel') &&
        !target.closest('.point-name') &&
        !target.closest('.marker-label')
      ) {
        closeSpotPanel();
      }
    }

    return {
      isShared: () => Boolean(localService.capabilities?.sharedScenes),
      updateImageList,
      saveFromEditor,
      ensureInfo,
      showSpotInfo,
      openLightbox,
      closeSpotPanel,
      closeLightbox,
      handleOutsideClick
    };
  }

  window.ScenicController = {create};
})();
