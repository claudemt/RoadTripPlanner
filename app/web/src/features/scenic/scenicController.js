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

    async function saveFromEditor(point, options = {}) {
      const description = el('pointScenicDescription').value.trim();
      const files = [...(el('pointScenicImages').files || [])];
      const shouldPublish = Boolean(el('pointPublishScenic')?.checked);
      if (!description && !files.length) return null;
      let imported = null;
      if (options.importFromLibrary) {
        const {response, data} = await localService.importScene(point.name);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '导入公共景点介绍失败');
        imported = data.scene;
      }
      const saved = await saveUserScenicInfo({
        id: imported?.id,
        name: point.name,
        title: point.name,
        description,
        files
      });
      if (!shouldPublish) return {privateScene: saved.scene};
      const {response, data} = await localService.publishUserScene(saved.scene.id, '从行程编辑器发布');
      if (!response.ok || !data?.ok) throw new Error(data?.message || '发布景点介绍失败');
      if (data.spot) cacheInfo(point.name, data.spot);
      return {...data, privateScene: saved.scene};
    }

    async function prepareImages(files) {
      if (files.length > 6) throw new Error('每次最多上传 6 张图片');
      const invalid = files.find((file) => !file.type.startsWith('image/') || file.size > 8 * 1024 * 1024);
      if (invalid) throw new Error('图片必须小于 8MB，且使用常见图片格式');
      const images = [];
      for (const file of files) images.push({name: file.name, dataUrl: await readFileAsDataUrl(file)});
      return images;
    }

    async function saveUserScenicInfo({id, name, title, description, files = []}) {
      const images = await prepareImages(files);
      const {response, data} = await localService.saveUserScene({
        id: id || undefined,
        name,
        title: title || name,
        description,
        images
      });
      if (!response.ok || !data?.ok) throw new Error(data?.message || '保存个人景点介绍失败');
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

    async function loadInfo(name, {fresh = false} = {}) {
      if (!fresh) {
        const cached = findInfo(name);
        if (cached) return cached;
      }
      try {
        const {response, data} = await localService.getScenic(name);
        if (!response.ok) return null;
        return cacheInfo(name, data?.spot || null);
      } catch (_) {
        return null;
      }
    }

    const ensureInfo = (name) => loadInfo(name);
    const getLibraryInfo = (name) => loadInfo(name, {fresh: true});

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
      updateImageList,
      saveFromEditor,
      saveUserScenicInfo,
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
