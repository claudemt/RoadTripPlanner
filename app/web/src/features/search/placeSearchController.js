(function () {
  function create({el, routeMap, escapeHtml, fixed, toast}) {
    let suggestItems = [];
    let activeSuggestIndex = -1;
    let suggestTimer = null;

    function setPointForm(name, lng, lat) {
      el('pointName').value = name || '';
      el('pointLngLat').value = `${fixed(lng)},${fixed(lat)}`;
    }

    function closeSuggestions() {
      el('suggestions').classList.remove('open');
      el('suggestions').innerHTML = '';
      activeSuggestIndex = -1;
    }

    function renderSuggestions() {
      const box = el('suggestions');
      if (!suggestItems.length) return closeSuggestions();
      box.innerHTML = suggestItems.map((tip, index) => {
        const address = [tip.district, tip.address].filter(Boolean).join(' ');
        return `<div class="suggestion ${index === activeSuggestIndex ? 'active' : ''}" data-index="${index}">
          <strong>${escapeHtml(tip.name)}</strong>
          <span>${escapeHtml(address || '点击后继续用地图服务识别坐标')}</span>
        </div>`;
      }).join('');
      box.classList.add('open');
      box.querySelectorAll('.suggestion').forEach((node) => {
        node.onmousedown = (event) => {
          event.preventDefault();
          chooseSuggestion(Number(node.dataset.index));
        };
      });
    }

    function onInput() {
      const keyword = el('pointSearchInput').value.trim();
      clearTimeout(suggestTimer);
      if (!keyword) return closeSuggestions();
      suggestTimer = setTimeout(async () => {
        try {
          suggestItems = await routeMap.searchTips(keyword);
          activeSuggestIndex = -1;
          renderSuggestions();
        } catch (_) {
          closeSuggestions();
        }
      }, 160);
    }

    function onKeydown(event) {
      const opened = el('suggestions').classList.contains('open');
      if (!opened) {
        if (event.key === 'Enter') searchPlace();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeSuggestIndex = Math.min(activeSuggestIndex + 1, suggestItems.length - 1);
        renderSuggestions();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeSuggestIndex = Math.max(activeSuggestIndex - 1, 0);
        renderSuggestions();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        chooseSuggestion(activeSuggestIndex >= 0 ? activeSuggestIndex : 0);
      } else if (event.key === 'Escape') {
        closeSuggestions();
      }
    }

    async function chooseSuggestion(index) {
      const tip = suggestItems[index];
      if (!tip) return;
      closeSuggestions();
      el('pointSearchInput').value = tip.name;
      try {
        const point = await routeMap.resolveTip(tip);
        setPointForm(point.name, point.lng, point.lat);
        routeMap.setZoomAndCenter(12, [point.lng, point.lat]);
        toast('已按地图建议识别：' + point.name);
      } catch (error) {
        toast('识别失败：' + error.message);
      }
    }

    async function searchPlace() {
      const keyword = el('pointSearchInput').value.trim();
      if (!keyword) return toast('请输入地点关键词。');
      try {
        const point = await routeMap.resolvePlace(keyword);
        setPointForm(point.name, point.lng, point.lat);
        routeMap.setZoomAndCenter(12, [point.lng, point.lat]);
        toast('已填入最匹配结果：' + point.name);
      } catch (error) {
        toast('没有找到地点：' + error.message);
      }
    }

    return {
      onInput,
      onKeydown,
      closeSuggestions,
      searchPlace,
      setPointForm,
      resolveByKeyword: (keyword) => routeMap.resolvePlace(keyword),
      reverseName: (lng, lat) => routeMap.reverseGeocode(lng, lat)
    };
  }

  window.PlaceSearchController = {create};
})();
