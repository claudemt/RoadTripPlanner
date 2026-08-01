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
    let openedAt = 0;
    const sceneCache = [];
    let userSceneCache = [];
    let userSceneCacheAt = 0;
    let publicImageUrls = [];
    let previewObjectUrls = [];

    function updateImageList() {
      const list = el('pointScenicImageList');
      if (!list) return;
      previewObjectUrls.forEach((url) => URL.revokeObjectURL(url));
      previewObjectUrls = [];
      const html = [];
      for (const url of publicImageUrls || []) {
        html.push(`<img src="${escapeAttr(url)}" alt="" title="公共图片" onclick="openLightbox('${escapeJsAttr(url)}')">`);
      }
      for (const file of [...(el('pointScenicImages').files || [])]) {
        const url = URL.createObjectURL(file);
        previewObjectUrls.push(url);
        html.push(`<img src="${escapeAttr(url)}" alt="" title="${escapeAttr(file.name)}">`);
      }
      list.innerHTML = html.join('');
    }

    function setPreviewImages(urls) {
      publicImageUrls = Array.isArray(urls) ? urls : [];
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
    }

    async function saveFromEditor(point, options = {}) {
      const description = el('pointScenicDescription').value.trim();
      const files = [...(el('pointScenicImages').files || [])];
      const unchanged = Boolean(options.prefilledDescription)
        && description === options.prefilledDescription
        && !files.length
        && JSON.stringify(publicImageUrls) === JSON.stringify(options.prefilledImages || []);
      if (unchanged) return null;
      if (!description && !files.length && !publicImageUrls.length) return null;
      const saved = await saveUserScenicInfo({
        name: point.name,
        title: point.name,
        description,
        files,
        imageUrls: publicImageUrls
      });
      userSceneCache = userSceneCache.filter((scene) => normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(point.name));
      if (saved.scene) userSceneCache.push(saved.scene);
      userSceneCacheAt = Date.now();
      return {privateScene: saved.scene};
    }

    async function prepareImages(files) {
      if (files.length > 6) throw new Error('每次最多上传 6 张图片');
      const invalid = files.find((file) => !file.type.startsWith('image/') || file.size > 8 * 1024 * 1024);
      if (invalid) throw new Error('图片必须小于 8MB，且使用常见图片格式');
      const images = [];
      for (const file of files) images.push({name: file.name, dataUrl: await readFileAsDataUrl(file)});
      return images;
    }

    async function saveUserScenicInfo({id, name, title, description, files = [], imageUrls = []}) {
      const images = await prepareImages(files);
      const {response, data} = await localService.saveUserScene({
        id: id || undefined,
        name,
        title: title || name,
        description,
        images: [...(imageUrls || []), ...images]
      });
      if (!response.ok || !data?.ok) throw new Error(data?.message || '保存个人景点介绍失败');
      userSceneCache = userSceneCache.filter((scene) => scene.id !== data.scene?.id && normalizeSpotName(scene.name || scene.title) !== normalizeSpotName(name));
      if (data.scene) userSceneCache.push(data.scene);
      userSceneCacheAt = Date.now();
      return data;
    }

    async function savePublicScenicInfo({name, title, description, files = [], changeNote = ''}) {
      const images = await prepareImages(files);
      const {response, data} = await localService.saveScenic({
        name,
        title: title || name,
        description,
        images,
        changeNote
      });
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
      setPreviewImages,
      saveFromEditor,
      saveUserScenicInfo,
      savePublicScenicInfo,
      ensureInfo,
      getLibraryInfo,
      showSpotInfo,
      openLightbox,
      closeSpotPanel,
      closeLightbox,
      handleOutsideClick
    };
  }

  window.ScenicController = {create};
})();
