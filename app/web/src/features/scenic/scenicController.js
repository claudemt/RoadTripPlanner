(function () {
  const MAX_UPLOAD_EDGE = 1920;
  const UPLOAD_QUALITY = 0.85;
  const SKIP_COMPRESS_BYTES = 400 * 1024;
  const MAX_IMAGES = 6;

  function create({
    el,
    localService,
    normalizeSpotName,
    escapeHtml,
    escapeAttr,
    escapeJsAttr,
    toast,
    confirmDialog
  }) {
    let openedAt = 0;
    const sceneCache = [];
    let userSceneCache = [];
    let userSceneCacheAt = 0;
    let savedImageUrls = [];
    let removedImageUrls = [];
    let pendingFiles = [];
    let pendingSeq = 0;
    let listBound = false;
    let previewBound = false;

    function totalImageCount() {
      return savedImageUrls.length + pendingFiles.length;
    }

    function bindImageList() {
      const list = el('pointScenicImageList');
      if (!list || listBound) return;
      listBound = true;
      list.addEventListener('click', (event) => {
        const item = event.target.closest('.scenic-image-item');
        if (!item) return;
        const kind = item.dataset.imageKind;
        const index = Number(item.dataset.imageIndex);
        if (event.target.closest('[data-scenic-remove]')) {
          event.preventDefault();
          event.stopPropagation();
          requestRemoveImage(kind, index);
          return;
        }
        const source = kind === 'saved' ? savedImageUrls[index] : pendingFiles[index]?.url;
        if (source) openLightbox(source);
      });
    }

    async function requestRemoveImage(kind, index) {
      if (!Number.isInteger(index) || index < 0) return;
      const target = kind === 'saved' ? savedImageUrls[index] : pendingFiles[index]?.file;
      if (!target) return;
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: '确认删除',
          compact: true
        });
        if (!ok) return;
      }
      removeImage(kind, index);
    }

    function removeImage(kind, index) {
      if (!Number.isInteger(index) || index < 0) return;
      if (kind === 'saved') {
        const [url] = savedImageUrls.splice(index, 1);
        if (url && !removedImageUrls.includes(url)) removedImageUrls.push(url);
      } else {
        const [entry] = pendingFiles.splice(index, 1);
        if (entry?.url) URL.revokeObjectURL(entry.url);
      }
      updateImageList();
    }

    function updateImageList() {
      const list = el('pointScenicImageList');
      if (!list) return;
      bindImageList();
      const html = [];
      savedImageUrls.forEach((url, index) => {
        html.push(`<div class="scenic-image-item" data-image-kind="saved" data-image-index="${index}">
          <img src="${escapeAttr(url)}" alt="" title="点击看大图">
          <button type="button" class="scenic-image-del" data-scenic-remove="saved" title="删除这张图片">✕</button>
        </div>`);
      });
      pendingFiles.forEach((entry, index) => {
        html.push(`<div class="scenic-image-item" data-image-kind="pending" data-image-index="${index}">
          <img src="${escapeAttr(entry.url)}" alt="" title="${escapeAttr(entry.file.name)}">
          <button type="button" class="scenic-image-del" data-scenic-remove="pending" title="移出待上传列表">✕</button>
        </div>`);
      });
      list.innerHTML = html.join('');
      const counter = el('pointScenicImageCount');
      if (counter) counter.textContent = `${totalImageCount()}/${MAX_IMAGES}`;
      const addBtn = el('pointScenicAddBtn');
      if (addBtn) {
        const full = totalImageCount() >= MAX_IMAGES;
        addBtn.disabled = full;
        addBtn.title = full ? `最多 ${MAX_IMAGES} 张图片` : '继续添加图片，不会覆盖已选图片';
      }
    }

    function clearPendingFiles() {
      pendingFiles.forEach((entry) => URL.revokeObjectURL(entry.url));
      pendingFiles = [];
    }

    function addSelectedFiles(selected) {
      const files = [...(selected || [])];
      const input = el('pointScenicImages');
      if (input) input.value = '';
      files.forEach((file) => {
        if (totalImageCount() >= MAX_IMAGES) return;
        const duplicated = pendingFiles.some((entry) => entry.file.name === file.name
          && entry.file.size === file.size
          && entry.file.lastModified === file.lastModified);
        if (duplicated) return;
        pendingSeq += 1;
        pendingFiles.push({id: pendingSeq, file, url: URL.createObjectURL(file)});
      });
      updateImageList();
      if (files.length && totalImageCount() >= MAX_IMAGES) toast(`最多 ${MAX_IMAGES} 张图片，多余的已忽略。`);
    }

    function setPreviewImages(urls) {
      savedImageUrls = Array.isArray(urls) ? urls.slice() : [];
      removedImageUrls = [];
    }

    function resetEditorImages() {
      setPreviewImages([]);
      clearPendingFiles();
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
    }

    function compressToDataUrl(file) {
      const compressible = /^image\/(jpeg|jpg|png|webp|bmp)$/i.test(file.type || '');
      if (!compressible) return readFileAsDataUrl(file);
      return new Promise((resolve) => {
        const objectUrl = URL.createObjectURL(file);
        const fallback = () => {
          URL.revokeObjectURL(objectUrl);
          readFileAsDataUrl(file).then(resolve).catch(() => resolve(''));
        };
        const image = new Image();
        image.onload = () => {
          try {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) {
              fallback();
              return;
            }
            const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(width, height));
            if (scale >= 1 && file.size <= SKIP_COMPRESS_BYTES) {
              fallback();
              return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext('2d');
            if (!context) {
              fallback();
              return;
            }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
              URL.revokeObjectURL(objectUrl);
              if (!blob || blob.size >= file.size) {
                readFileAsDataUrl(file).then(resolve).catch(() => resolve(''));
                return;
              }
              readFileAsDataUrl(blob).then(resolve).catch(() => resolve(''));
            }, 'image/jpeg', UPLOAD_QUALITY);
          } catch (_) {
            fallback();
          }
        };
        image.onerror = fallback;
        image.src = objectUrl;
      });
    }

    async function saveFromEditor(point, options = {}) {
      const description = el('pointScenicDescription').value.trim();
      const files = pendingFiles.map((entry) => entry.file);
      const unchanged = Boolean(options.prefilledDescription)
        && description === options.prefilledDescription
        && !files.length
        && !removedImageUrls.length
        && JSON.stringify(savedImageUrls) === JSON.stringify(options.prefilledImages || []);
      if (unchanged) return null;
      if (!description && !files.length && !savedImageUrls.length && !removedImageUrls.length) return null;
      const displayName = String(point?.name || '').trim();

      const originalName = String(options.originalName || '').trim();
      const canonName = window.PoiAliasStore?.canonicalFor?.({name: originalName}) || originalName;
      const sceneKey = canonName || displayName;
      if (sceneKey && displayName && sceneKey !== displayName) {
        window.PoiAliasStore?.remember?.({
          name: sceneKey,
          alias: displayName,
          lng: point?.lng,
          lat: point?.lat
        });
      }
      const saved = await saveUserScenicInfo({
        name: sceneKey,
        title: displayName || sceneKey,
        description,
        files,
        imageUrls: savedImageUrls,
        removedImageUrls
      });
      userSceneCache = userSceneCache.filter((scene) => normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(displayName));
      if (saved.scene) userSceneCache.push(saved.scene);
      userSceneCacheAt = Date.now();
      return {privateScene: saved.scene};
    }

    async function saveSpotFromEditor({
      sceneMode = 'private',
      sceneId = '',
      originalName = '',
      name = '',
      description = '',
      changeNote = ''
    } = {}) {
      const typedName = String(name || '').trim();
      if (!typedName) throw new Error('请填写景点名称');

      const sceneKey = String(originalName || '').trim() || typedName;
      const files = pendingFiles.map((entry) => entry.file);
      if (sceneKey !== typedName) {
        window.PoiAliasStore?.remember?.({name: sceneKey, alias: typedName});
      }
      if (sceneMode === 'public') {
        const data = await savePublicScenicInfo({
          name: sceneKey,
          title: typedName,
          description,
          files,
          changeNote,
          removedImageUrls
        });
        return {spot: data.spot, version: data.version, unchanged: Boolean(data.unchanged)};
      }
      const data = await saveUserScenicInfo({
        id: sceneId,
        name: sceneKey,
        title: typedName,
        description,
        files,
        imageUrls: savedImageUrls,
        removedImageUrls
      });
      return {spot: data.scene};
    }

    async function prepareImages(files) {
      if (files.length > MAX_IMAGES) throw new Error(`每次最多上传 ${MAX_IMAGES} 张图片`);
      const invalid = files.find((file) => !file.type.startsWith('image/') || file.size > 8 * 1024 * 1024);
      if (invalid) throw new Error('图片必须小于 8MB，且使用常见图片格式');
      return Promise.all(files.map(async (file) => ({name: file.name, dataUrl: await compressToDataUrl(file)})));
    }

    async function saveUserScenicInfo({id, name, title, description, files = [], imageUrls = [], removedImageUrls: removeList = []}) {
      const images = await prepareImages(files);
      const payload = {
        id: id || undefined,
        name,
        title: title || name,
        description,
        images: [...(imageUrls || []), ...images]
      };
      if (Array.isArray(removeList) && removeList.length) payload.removeImages = removeList.slice();
      const {response, data} = await localService.saveUserScene(payload);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '保存个人景点介绍失败');
      userSceneCache = userSceneCache.filter((scene) => scene.id !== data.scene?.id && normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(name));
      if (data.scene) userSceneCache.push(data.scene);
      userSceneCacheAt = Date.now();
      return data;
    }

    async function savePublicScenicInfo({name, title, description, files = [], changeNote = '', removedImageUrls: removeList = []}) {
      const images = await prepareImages(files);
      const payload = {
        name,
        title: title || name,
        description,
        images,
        changeNote
      };
      if (Array.isArray(removeList) && removeList.length) payload.removeImages = removeList.slice();
      const {response, data} = await localService.saveScenic(payload);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '保存公共景点介绍失败');
      if (data.spot) cacheInfo(name, data.spot);
      return data;
    }

    function findInfo(name) {
      const target = normalizeSpotName(name);
      if (!target) return null;
      return sceneCache.find((spot) => {
        return [spot.name, spot.title].some((alias) => {
          const normalized = normalizeSpotName(alias);
          return normalized && target === normalized;
        });
      }) || null;
    }

    function cacheInfo(name, spot) {
      for (let index = sceneCache.length - 1; index >= 0; index -= 1) {
        if (normalizeSpotName(sceneCache[index].name || sceneCache[index].title) === normalizeSpotName(name)) {
          sceneCache.splice(index, 1);
        }
      }
      if (spot) sceneCache.push(spot);
      return spot || null;
    }

    function userSceneToSpot(scene) {
      if (!scene) return null;
      return {
        id: scene.id,
        name: scene.name,
        title: scene.title || scene.name,
        description: scene.description || '',
        images: scene.images || [],
        version: scene.sourceVersion || 0,
        private: true,
        updatedAt: scene.updatedAt
      };
    }

    async function loadUserScenes({fresh = false} = {}) {
      if (!fresh && userSceneCacheAt && Date.now() - userSceneCacheAt < 5 * 60 * 1000) return userSceneCache;
      const {response, data} = await localService.listUserScenes({force: fresh});
      if (!response.ok || !data?.ok) return userSceneCache;
      userSceneCache = data.scenes || [];
      userSceneCacheAt = Date.now();
      return userSceneCache;
    }

    async function findUserInfo(name, {fresh = false} = {}) {
      const scenes = await loadUserScenes({fresh});
      const target = normalizeSpotName(name);
      const scene = scenes.find((item) => [item.name, item.title].some((alias) => normalizeSpotName(alias) === target));
      return userSceneToSpot(scene);
    }

    async function loadInfo(name, {fresh = false, publicOnly = false} = {}) {
      if (!publicOnly) {
        try {
          const mine = await findUserInfo(name, {fresh});
          if (mine) return mine;
        } catch (_) {}
      }
      if (!fresh) {
        const cached = findInfo(name);
        if (cached) return cached;
      }
      try {
        const {response, data} = await localService.getScenic(name, {force: fresh});
        if (!response.ok) return null;
        return cacheInfo(name, data?.spot || null);
      } catch (_) {
        return null;
      }
    }

    const ensureInfo = (name, options = {}) => loadInfo(name, options);
    const getLibraryInfo = (name) => loadInfo(name, {fresh: true, publicOnly: true});

    async function showSpotInfo(name) {
      const spot = await ensureInfo(name);
      if (!spot) return toast('暂时没有这个地点的图文介绍。');
      el('spotTitle').textContent = spot.title;
      const images = (spot.images || []).map((source) => {
        return `<img src="${escapeAttr(source)}" alt="${escapeAttr(spot.title)}" onclick="openLightbox('${escapeJsAttr(source)}')">`;
      }).join('');
      el('spotBody').innerHTML = `
        ${spot.contributor?.email ? `<div class="spot-contributor">贡献者：<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(spot.contributor.email)}')">${escapeHtml(spot.contributor.nickname || '未知用户')}</button></div>` : ''}
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

    function cleanVideoText(value, max) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > max ? `${text.slice(0, max)}…` : text;
    }

    function fitPreviewStage() {
      const stage = el('spotPreviewStage');
      if (!stage) return;
      const frame = stage.querySelector('.spot-preview-frame');
      if (!frame) return;
      frame.style.transform = `scale(${Math.max(0.1, stage.clientWidth / 1280)})`;
    }

    function renderVideoPreview({name, description, images} = {}) {
      const stage = el('spotPreviewStage');
      if (!stage) return;
      const pictures = (images || []).filter(Boolean).slice(0, 2);
      const text = cleanVideoText(description || '暂无介绍', 130);
      const title = cleanVideoText(name || '景点介绍', 24);
      const imageHeight = 74;
      const descFont = text.length > 84 ? 15 : 17;
      const columns = pictures.length > 1 ? '1fr 1fr' : '1fr';
      const imagesHtml = pictures.length
        ? `<div class="vp-scenic-images" style="grid-template-columns:${columns};height:${imageHeight}px">${pictures.map((src) => `<img src="${escapeAttr(src)}" alt="">`).join('')}</div>`
        : '';
      stage.innerHTML = `
        <div class="spot-preview-frame">
          <div class="vp-scenic">
            ${imagesHtml}
            <div class="vp-scenic-text${pictures.length ? ' has-images' : ''}">
              <div class="vp-scenic-title-row">
                <span class="vp-scenic-bar"></span>
                <div class="vp-scenic-title">${escapeHtml(title)}</div>
              </div>
              <div class="vp-scenic-desc" style="font-size:${descFont}px">${escapeHtml(text)}</div>
            </div>
          </div>
        </div>`;
      fitPreviewStage();
    }

    function currentEditorImages() {
      return [...savedImageUrls, ...pendingFiles.map((entry) => entry.url)];
    }

    function openPreview({name, description} = {}) {
      renderVideoPreview({name, description, images: currentEditorImages()});
      el('spotPreviewModal')?.classList.add('open');
      if (!previewBound) {
        previewBound = true;
        window.addEventListener('resize', fitPreviewStage);
      }
      requestAnimationFrame(fitPreviewStage);
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
      updateImageList,
      addSelectedFiles,
      setPreviewImages,
      resetEditorImages,
      saveFromEditor,
      saveSpotFromEditor,
      saveUserScenicInfo,
      savePublicScenicInfo,
      ensureInfo,
      getLibraryInfo,
      showSpotInfo,
      openPreview,
      currentEditorImages,
      openLightbox,
      closeSpotPanel,
      closeLightbox,
      handleOutsideClick
    };
  }

  window.ScenicController = {create};
})();
