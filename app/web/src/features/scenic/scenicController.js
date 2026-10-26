(function () {
  const MAX_UPLOAD_EDGE = 2560;
  const TARGET_UPLOAD_BYTES = 8 * 1024 * 1024;
  const MAX_INPUT_BYTES = 64 * 1024 * 1024;
  const MAX_BATCH_BYTES = 120 * 1024 * 1024;
  const MAX_IMAGES = 6;
  const HEIC_PATTERN = /^image\/hei[cf]/i;
  const JPEG_PATTERN = /^image\/jpe?g$/i;

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

    function guessImageMime(name) {
      const ext = String(name || '').split('.').pop().toLowerCase();
      if (ext === 'heic') return 'image/heic';
      if (ext === 'heif') return 'image/heif';
      if (ext === 'png') return 'image/png';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'gif') return 'image/gif';
      if (ext === 'avif') return 'image/avif';
      if (ext === 'bmp') return 'image/bmp';
      if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
      return 'image/jpeg';
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || '');
          const comma = raw.indexOf(',');
          if (comma < 0) {
            reject(new Error('图片读取失败'));
            return;
          }
          const mime = file.type || guessImageMime(file.name);
          resolve(`data:${mime};base64,${raw.slice(comma + 1)}`);
        };
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
    }

    let progressUi = null;

    function ensureProgressUi() {
      if (progressUi) return progressUi;
      const root = document.createElement('div');
      root.className = 'scenic-upload-progress';
      root.hidden = true;
      root.innerHTML = `
        <div class="scenic-upload-head">
          <span class="scenic-upload-title"></span>
          <span class="scenic-upload-percent"></span>
        </div>
        <div class="scenic-upload-track"><span></span></div>
        <div class="scenic-upload-detail"></div>`;
      document.body.appendChild(root);
      progressUi = {
        root,
        title: root.querySelector('.scenic-upload-title'),
        percent: root.querySelector('.scenic-upload-percent'),
        bar: root.querySelector('.scenic-upload-track span'),
        detail: root.querySelector('.scenic-upload-detail')
      };
      return progressUi;
    }

    function showUploadProgress(title, percent, detail) {
      const ui = ensureProgressUi();
      ui.root.hidden = false;
      ui.root.classList.add('open');
      ui.title.textContent = title;
      ui.percent.textContent = `${Math.round(percent)}%`;
      ui.bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
      ui.detail.textContent = detail || '';
    }

    function hideUploadProgress() {
      if (!progressUi) return;
      progressUi.root.classList.remove('open');
      progressUi.root.hidden = true;
    }

    function createImageProgress(files) {
      const total = Math.max(1, files.reduce((sum, file) => sum + Math.max(1, file.size), 0));
      const hasHeic = files.some((file) => HEIC_PATTERN.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || ''));
      let completed = 0;
      let currentSize = 1;
      let detail = '';
      let last = 0;
      const report = (percent, nextDetail) => {
        last = Math.max(last, percent);
        showUploadProgress('正在处理照片', Math.min(99, last), nextDetail || detail);
      };
      return {
        begin(file, index) {
          currentSize = Math.max(1, file.size || 1);
          detail = `第 ${index + 1}/${files.length} 张 · ${file.name}`;
          report((completed / total) * 82, detail);
        },
        step(ratio) {
          const fileRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
          report(((completed + currentSize * fileRatio) / total) * 82, detail);
        },
        end(file) {
          completed += Math.max(1, file?.size || 1);
          report((completed / total) * 82, detail);
        },
        upload(ratio) {
          const value = 82 + Math.max(0, Math.min(1, Number(ratio) || 0)) * 14;
          const converting = hasHeic && ratio >= 1;
          report(value, converting
            ? '正在服务器转换 HEIC 并压缩…'
            : ratio >= 1 ? '正在保存照片…' : '正在上传照片…');
        },
        finish() {
          report(100, '照片已保存');
          setTimeout(hideUploadProgress, 500);
        },
        fail() {
          hideUploadProgress();
        }
      };
    }

    function canvasToBlob(canvas, quality) {
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }

    async function prepareJpeg(file, progress) {
      const objectUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('图片无法读取'));
          img.src = objectUrl;
        });
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error('图片尺寸无效');
        const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(width, height));
        if (scale >= 1 && file.size <= TARGET_UPLOAD_BYTES) {
          progress?.step(1);
          return readFileAsDataUrl(file);
        }
        let targetWidth = Math.max(1, Math.round(width * scale));
        let targetHeight = Math.max(1, Math.round(height * scale));
        let blob = null;
        for (let shrink = 0; shrink < 3; shrink += 1) {
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const context = canvas.getContext('2d');
          if (!context) break;
          context.drawImage(image, 0, 0, targetWidth, targetHeight);
          let low = 0.45;
          let high = 0.92;
          let candidate = await canvasToBlob(canvas, high);
          progress?.step(0.35 + shrink * 0.15);
          if (candidate && candidate.size <= TARGET_UPLOAD_BYTES) {
            blob = candidate;
            break;
          }
          for (let attempt = 0; attempt < 5 && low <= high; attempt += 1) {
            const quality = (low + high) / 2;
            const next = await canvasToBlob(canvas, quality);
            progress?.step(Math.min(0.9, 0.45 + attempt * 0.1));
            if (next && next.size <= TARGET_UPLOAD_BYTES) {
              blob = next;
              low = quality + 0.02;
            } else {
              high = quality - 0.02;
            }
          }
          if (blob) break;
          targetWidth = Math.max(1, Math.round(targetWidth * 0.8));
          targetHeight = Math.max(1, Math.round(targetHeight * 0.8));
        }
        if (!blob || (scale >= 1 && blob.size >= file.size)) return readFileAsDataUrl(file);
        return readFileAsDataUrl(blob);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    async function prepareFileDataUrl(file, progress) {
      const heic = HEIC_PATTERN.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
      if (heic) {
        progress?.step(0.15);
        let convertedBlob = null;
        try {
          const module = await import('heic2any');
          const convert = module.default || module;
          const converted = await convert({blob: file, toType: 'image/jpeg', quality: 0.92});
          convertedBlob = Array.isArray(converted) ? converted[0] : converted;
        } catch (_) {
          throw new Error(`「${file.name}」无法转换，请在相册中导出为 JPEG 后重试`);
        }
        if (!convertedBlob || !convertedBlob.size) throw new Error(`「${file.name}」转换结果为空`);
        progress?.step(0.55);
        const convertedName = String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
        const jpegFile = new File([convertedBlob], convertedName, {type: 'image/jpeg', lastModified: file.lastModified || Date.now()});
        return prepareJpeg(jpegFile, {
          step: (ratio) => progress?.step(0.55 + Math.max(0, Math.min(1, Number(ratio) || 0)) * 0.45)
        });
      }
      if (JPEG_PATTERN.test(file.type || '') || /\.jpe?g$/i.test(file.name || '')) {
        return prepareJpeg(file, progress);
      }
      progress?.step(0.8);
      return readFileAsDataUrl(file);
    }

    async function saveFromEditor(point, options = {}) {
      const description = el('pointScenicDescription').value.trim();
      const files = pendingFiles.map((entry) => entry.file);
      const displayName = String(point?.name || '').trim();
      const originalName = String(options.originalName || '').trim();
      const previousTitle = String(options.prefilledTitle || '').trim();
      const previousImages = Array.isArray(options.prefilledImages) ? options.prefilledImages : [];
      const sceneId = String(options.prefilledSceneId || '').trim();
      const savedName = String(options.prefilledSceneName || '').trim();
      const hasPrivateScene = Boolean(sceneId || options.prefilledPrivate);
      const sceneName = savedName || originalName;
      const displayIsSceneKey = Boolean(displayName && sceneName
        && normalizeSpotName(displayName) === normalizeSpotName(sceneName));
      const aliasCanonical = window.PoiAliasStore?.canonicalFor?.({name: displayName}) || '';
      const displayIsNickname = Boolean(aliasCanonical
        && normalizeSpotName(aliasCanonical) !== normalizeSpotName(displayName));
      const title = displayIsNickname
        ? displayName
        : (hasPrivateScene && previousTitle && displayIsSceneKey ? previousTitle : displayName);
      const contentChanged = description !== String(options.prefilledDescription || '')
        || files.length > 0
        || removedImageUrls.length > 0
        || JSON.stringify(savedImageUrls) !== JSON.stringify(previousImages);
      const titleChanged = hasPrivateScene && title !== previousTitle;
      if (!contentChanged && !titleChanged) return null;
      if (!hasPrivateScene && !description && !files.length && !savedImageUrls.length && !removedImageUrls.length) return null;
      const canonName = window.PoiAliasStore?.canonicalFor?.({name: originalName}) || originalName;
      const sceneKey = savedName || canonName || displayName;
      if (!sceneKey) return null;
      if (sceneKey !== title) {
        window.PoiAliasStore?.remember?.({
          name: sceneKey,
          alias: title,
          lng: point?.lng,
          lat: point?.lat
        });
      }
      const saved = await saveUserScenicInfo({
        id: sceneId || undefined,
        name: sceneKey,
        title: title || sceneKey,
        description,
        files,
        imageUrls: savedImageUrls,
        removedImageUrls
      });
      userSceneCache = userSceneCache.filter((scene) => {
        return scene.id !== saved.scene?.id && normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(sceneKey);
      });
      if (saved.scene) userSceneCache.push(saved.scene);
      userSceneCacheAt = Date.now();
      return {privateScene: saved.scene};
    }

    async function saveSpotFromEditor({
      sceneMode = 'private',
      sceneId = '',
      originalName = '',
      name = '',
      title = '',
      description = '',
      changeNote = ''
    } = {}) {
      const canonicalName = String(name || '').trim() || String(originalName || '').trim();
      const displayTitle = String(title || '').trim() || canonicalName;
      if (!canonicalName) throw new Error('请填写景点名称');

      const sceneKey = String(originalName || '').trim() || canonicalName;
      const files = pendingFiles.map((entry) => entry.file);
      if (sceneKey !== displayTitle) {
        window.PoiAliasStore?.remember?.({name: sceneKey, alias: displayTitle});
      }
      if (sceneMode === 'public') {
        const data = await savePublicScenicInfo({
          name: sceneKey,
          title: displayTitle,
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
        title: displayTitle,
        description,
        files,
        imageUrls: savedImageUrls,
        removedImageUrls
      });
      return {spot: data.scene};
    }

    async function prepareImages(files, progress = null) {
      if (files.length > MAX_IMAGES) throw new Error(`每次最多上传 ${MAX_IMAGES} 张图片`);
      for (const file of files) {
        const heic = HEIC_PATTERN.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
        if (!/^image\//i.test(file.type || '') && !heic) {
          throw new Error(`「${file.name}」不是图片文件`);
        }
        if (file.size > MAX_INPUT_BYTES) {
          throw new Error(`「${file.name}」超过 ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB，请先在相册中导出为 JPEG 后重试`);
        }
      }
      const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size || 0), 0);
      if (totalBytes > MAX_BATCH_BYTES) {
        throw new Error(`本次照片合计超过 ${Math.round(MAX_BATCH_BYTES / 1024 / 1024)}MB，请分批保存`);
      }
      const prepared = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        progress?.begin(file, index);
        const dataUrl = await prepareFileDataUrl(file, progress);
        progress?.step(1);
        progress?.end(file);
        const name = /\.(heic|heif)$/i.test(file.name || '')
          ? `${String(file.name).replace(/\.[^.]+$/, '')}.jpg`
          : file.name;
        prepared.push({name, dataUrl});
      }
      return prepared;
    }

    async function saveUserScenicInfo({id, name, title, description, files = [], imageUrls = [], removedImageUrls: removeList = []}) {
      const progress = files.length ? createImageProgress(files) : null;
      try {
        const images = await prepareImages(files, progress);
        const payload = {
          id: id || undefined,
          name,
          title: title || name,
          description,
          images: [...(imageUrls || []), ...images]
        };
        if (Array.isArray(removeList) && removeList.length) payload.removeImages = removeList.slice();
        const {response, data} = await localService.saveUserScene(payload, {
          onProgress: progress ? (loaded, total) => progress.upload(total ? loaded / total : 1) : undefined
        });
        if (!response.ok || !data?.ok) throw new Error(data?.message || '保存个人景点介绍失败');
        progress?.finish();
        userSceneCache = userSceneCache.filter((scene) => scene.id !== data.scene?.id && normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(name));
        if (data.scene) userSceneCache.push(data.scene);
        userSceneCacheAt = Date.now();
        return data;
      } catch (error) {
        progress?.fail();
        throw error;
      }
    }

    async function savePublicScenicInfo({name, title, description, files = [], changeNote = '', removedImageUrls: removeList = []}) {
      const progress = files.length ? createImageProgress(files) : null;
      try {
        const images = await prepareImages(files, progress);
        const payload = {
          name,
          title: title || name,
          description,
          images,
          changeNote
        };
        if (Array.isArray(removeList) && removeList.length) payload.removeImages = removeList.slice();
        const {response, data} = await localService.saveScenic(payload, {
          onProgress: progress ? (loaded, total) => progress.upload(total ? loaded / total : 1) : undefined
        });
        if (!response.ok || !data?.ok) throw new Error(data?.message || '保存公共景点介绍失败');
        progress?.finish();
        if (data.spot) cacheInfo(name, data.spot);
        return data;
      } catch (error) {
        progress?.fail();
        throw error;
      }
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
      const canonical = window.PoiAliasStore?.canonicalFor?.({name}) || '';
      const lookups = canonical && normalizeSpotName(canonical) !== normalizeSpotName(name)
        ? [name, canonical]
        : [name];
      if (!publicOnly) {
        for (const lookup of lookups) {
          try {
            const mine = await findUserInfo(lookup, {fresh});
            if (mine) return mine;
          } catch (_) {}
        }
      }
      if (!fresh) {
        for (const lookup of lookups) {
          const cached = findInfo(lookup);
          if (cached) return cached;
        }
      }
      if (localService.capabilities?.sharedScenes === false) return null;
      for (const lookup of lookups) {
        try {
          const {response, data} = await localService.getScenic(lookup, {force: fresh});
          if (response.ok && data?.spot) return cacheInfo(lookup, data.spot);
        } catch (_) {}
      }
      return null;
    }

    const ensureInfo = (name, options = {}) => loadInfo(name, options);
    const getLibraryInfo = (name) => loadInfo(name, {fresh: true, publicOnly: true});

    async function showSpotInfo(name) {
      const spot = await ensureInfo(name);
      if (!spot) return toast('暂时没有这个地点的图文介绍。');
      const alias = window.PoiAliasStore?.aliasFor?.({name: spot.name || name}) || '';
      const title = alias || spot.title || spot.name || name;
      el('spotTitle').textContent = title;
      const images = (spot.images || []).map((source) => {
        return `<img src="${escapeAttr(source)}" alt="${escapeAttr(title)}" onclick="openLightbox('${escapeJsAttr(source)}')">`;
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
