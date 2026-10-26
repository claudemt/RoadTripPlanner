(function () {
  function create({
    el,
    cleanRouteName,
    cleanDayTitle,
    dayLabel,
    getDayPoints,
    formatTripMetric,
    fixed,
    escapeHtml,
    escapeAttr,
    escapeJsAttr
  }) {
    const transportLabels = {
      drive: '车',
      ride: '骑',
      walk: '步'
    };

    function normalizeTransportMode(value) {
      return window.RouteModel?.normalizeTransportMode?.(value) || 'drive';
    }

    function renderRouteSelect({routeBook, route}) {
      const hasRoutes = Boolean(routeBook.routes?.length);
      if (el('routeSelect')) el('routeSelect').hidden = false;
      if (el('routeViewSelect')) el('routeViewSelect').hidden = !hasRoutes;
      if (!hasRoutes) {
        el('routeSelect').innerHTML = '<option value="">请新建路线</option>';
        el('routeSelect').value = '';
        return;
      }
      const localOptions = routeBook.routes
        .map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(cleanRouteName(item.name) || item.id)}</option>`)
        .join('');
      el('routeSelect').innerHTML = localOptions;
      el('routeSelect').value = route?.id || routeBook.routes[0]?.id || '';
    }

    function renderDaySelect({route, currentRouteView}) {
      if (!route) {
        el('daySelect').innerHTML = '';
        el('routeViewSelect').innerHTML = '';
        return 'all';
      }
      const selectedDay = el('daySelect').value || '0';
      el('daySelect').innerHTML = route.days
        .map((day, index) => `<option value="${index}">${escapeHtml(dayLabel(day, index))}</option>`)
        .join('');
      if (route.days[Number(selectedDay)]) el('daySelect').value = selectedDay;
      el('routeViewSelect').innerHTML = `<option value="all">总览</option>` + route.days
        .map((day, index) => `<option value="${index}">${escapeHtml(dayLabel(day, index))}</option>`)
        .join('');
      const nextView = currentRouteView !== 'all' && !route.days[Number(currentRouteView)]
        ? 'all'
        : currentRouteView;
      el('routeViewSelect').value = nextView;
      return nextView;
    }

    function simplifyPolicy(value) {
      return window.RouteModel?.simplifyPolicyLabel?.(value) || String(value || '');
    }

    function renderSegmentRow({dayIndex, segmentIndex, segment, transportLabel}) {
      if (!segment) return '<div class="segment">↓ 尚未计算</div>';
      if (segment.error) {
        const expandedKey = `${dayIndex}:${segmentIndex}`;
        const expanded = Boolean(window.__segmentExpanded?.has(expandedKey));
        const expandHtml = expanded
          ? renderSegmentExpandPanel({dayIndex, segmentIndex, segment, alternatives: [], selectedAlt: 0, custom: null, usingCustom: false, transportLabel})
          : '';
        return `<div class="segment error">↓ ${escapeHtml(segment.error)}</div>${expandHtml}`;
      }
      const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
      const selectedAlt = Number.isFinite(Number(segment.selectedAlternative))
        ? Math.max(0, Math.min(Math.floor(Number(segment.selectedAlternative)), Math.max(0, alternatives.length - 1)))
        : 0;
      const currentAlt = alternatives[selectedAlt];
      const custom = segment.customAlternative || null;
      const usingCustom = Boolean(segment.useCustom && custom);
      const auto = segment.autoAlternative || null;
      const usingAuto = Boolean(segment.useAuto && auto);
      const currentPolicy = usingAuto
        ? (auto.label || '自动规划')
        : (usingCustom
          ? (custom.label || '自定义轨迹')
          : (currentAlt?.policy ? simplifyPolicy(currentAlt.policy) : (selectedAlt === 0 ? '最快' : '')));
      const note = String(segment.note || '').trim();
      const displayPolicy = note || currentPolicy;
      const metric = formatTripMetric(segment.distance, segment.duration);
      const expandedKey = `${dayIndex}:${segmentIndex}`;
      const expanded = Boolean(window.__segmentExpanded?.has(expandedKey));
      const policyText = displayPolicy ? `${escapeHtml(displayPolicy)} · ` : '';
      const expandHtml = expanded
        ? renderSegmentExpandPanel({dayIndex, segmentIndex, segment, alternatives, selectedAlt, custom, usingCustom, transportLabel})
        : '';
      return `
        <div class="segment ${segment.error ? 'error' : 'ok'}">
          <span class="segment-main">↓ ${transportLabel} · ${policyText}${metric}</span>
          <button type="button" class="segment-note-edit" title="修改路线备注" onclick="editSegmentNote(${dayIndex},${segmentIndex})">✎</button>
        </div>${expandHtml}`;
    }

    function renderSegmentExpandPanel({dayIndex, segmentIndex, segment, alternatives, selectedAlt, custom, usingCustom, transportLabel}) {
      const note = String(segment.note || '').trim();
      const auto = segment.autoAlternative || null;
      const usingAuto = Boolean(segment.useAuto && auto);
      const rows = alternatives.map((alt, index) => {
        const active = !usingCustom && !usingAuto && index === selectedAlt;
        const baseLabel = alt.policy ? simplifyPolicy(alt.policy) : '';
        const label = active && note ? note : baseLabel;
        const labelPart = label ? ` · ${escapeHtml(label)}` : '';
        return `
          <div class="segment segment-alt-row ${active ? 'active' : ''}" role="button" onclick="selectSegmentAlternative(${dayIndex},${segmentIndex},${index})">
            <span>↓ ${transportLabel}${labelPart} · ${formatTripMetric(alt.distance, alt.duration)}</span>
            <button type="button" class="segment-alt-chip-pin" title="置为第一选择" onclick="event.stopPropagation();pinSegmentAlternative(${dayIndex},${segmentIndex},${index})">✓</button>
          </div>`;
      }).join('');
      const autoRow = segment.fetchingAuto
        ? `<div class="segment segment-alt-row segment-alt-loading"><span>↓ ${transportLabel} · 正在分析路网…</span></div>`
        : (segment.autoError
          ? `<div class="segment segment-alt-row segment-alt-loading" title="${escapeHtml(segment.autoError)}"><span>↓ ${transportLabel} · 自动规划暂不可用</span></div>`
          : '');
      const customRow = custom
        ? `<div class="segment segment-alt-row ${usingCustom ? 'active' : ''}" role="button" onclick="selectCustomAlternative(${dayIndex},${segmentIndex})">
            <span>↓ ${transportLabel} · ${escapeHtml(usingCustom && note ? note : (custom.label || '自定义轨迹'))} · ${formatTripMetric(custom.distance, custom.duration)}</span>
            <button type="button" class="segment-alt-chip-del" title="删除自定义轨迹" onclick="event.stopPropagation();deleteSegmentCustomRoute(${dayIndex},${segmentIndex})">✕</button>
          </div>`
        : '';
      return `
        <div class="segment-alternatives">
          ${rows}${autoRow}${customRow}
          <button type="button" class="segment-alt-add" onclick="openSegmentCustomInput(${dayIndex},${segmentIndex})">+ 自定义轨迹</button>
        </div>`;
    }

    function renderDays({route, segmentResults, currentRouteView}) {
      if (!route) {
        el('daysList').innerHTML = '<div class="account-empty">还没有路线。</div>';
        return;
      }
      const visibleDays = route.days
        .map((day, dayIndex) => ({day, dayIndex}))
        .filter(({dayIndex}) => currentRouteView === 'all' || Number(currentRouteView) === dayIndex);
      el('daysList').innerHTML = visibleDays.map(({day, dayIndex}) => {
        const dayResult = segmentResults[dayIndex] || {segments: []};
        const dayDistance = dayResult.segments.reduce((sum, segment) => sum + (segment.distance || 0), 0);
        const dayDuration = dayResult.segments.reduce((sum, segment) => sum + (segment.duration || 0), 0);
        const points = getDayPoints(day);
        const readyPoints = points.filter((item) => window.RouteModel.isPointReady(item.point));
        const title = cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`;
      const pointHtml = points.map((item, pointIndex) => {
        const typeClass = item.role === '起' ? 'start' : item.role === '终' ? 'end' : 'waypoint';
        const mode = normalizeTransportMode(item.point.transportMode);
        const editButtons = item.kind === 'waypoint'
          ? `<button class="small primary" title="添加" onclick="openPointEditor({mode:'insertAfter',dayIndex:${dayIndex},afterKind:'waypoint',waypointIndex:${item.waypointIndex}})">+</button><button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'waypoint',waypointIndex:${item.waypointIndex}})">编辑</button><button class="small danger" title="删除" onclick="deleteWaypoint(${dayIndex},${item.waypointIndex})">✕</button>`
          : item.kind === 'from'
            ? `<button class="small primary" title="添加" onclick="openPointEditor({mode:'insertAfter',dayIndex:${dayIndex},afterKind:'from'})">+</button><button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'from'})">编辑</button>`
            : `<button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'to'})">编辑</button>`;
        const isTo = item.kind === 'to';
        const isFrom = item.kind === 'from';
        const readyIndex = readyPoints.indexOf(item);
        const inSegIndex = readyIndex <= 0 ? -1 : readyIndex - 1;
        const inSegment = inSegIndex >= 0 ? dayResult.segments[inSegIndex] : undefined;
        const showMoreBtn = !isFrom && Boolean(inSegment);
        const moreRouteBtn = showMoreBtn
          ? (() => {
              const expanded = Boolean(window.__segmentExpanded?.has(`${dayIndex}:${inSegIndex}`));
              return `<button class="small segment-alt-toggle ${expanded ? 'active' : ''}" title="这一段的其他路线" onclick="toggleSegmentAlternatives(${dayIndex},${inSegIndex})">路线</button>`;
            })()
          : '';
        const outSegment = !isTo && readyIndex >= 0 ? dayResult.segments[readyIndex] : undefined;
        const hasOutSegment = Boolean(outSegment);
        const transportLabel = escapeHtml(transportLabels[normalizeTransportMode(outSegment?.mode || points[pointIndex + 1]?.point?.transportMode)] || '车');
        const segmentHtml = hasOutSegment
          ? renderSegmentRow({dayIndex, segmentIndex: readyIndex, segment: outSegment, transportLabel})
          : '';
          const nameClick = item.point.useScenic === false
            ? ''
            : ` onclick="showSpotInfo('${escapeJsAttr(item.point.name)}')" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted"`;
          const slotHtml = pointIndex === 0 ? '' : `
            <div class="point-slot" data-day-index="${dayIndex}" data-slot-index="${pointIndex}" ondragenter="pointDragEnterSlot(event)" ondragover="pointDragOverSlot(event)" ondragleave="pointDragLeaveSlot(event)" ondrop="pointDropSlot(event)"></div>`;
          const endSlotHtml = pointIndex === points.length - 1 ? `
            <div class="point-slot" data-day-index="${dayIndex}" data-slot-index="${points.length}" ondragenter="pointDragEnterSlot(event)" ondragover="pointDragOverSlot(event)" ondragleave="pointDragLeaveSlot(event)" ondrop="pointDropSlot(event)"></div>` : '';
          return `
            ${slotHtml}
            <div class="point" draggable="true" data-day-index="${dayIndex}" data-point-index="${pointIndex}" ondragstart="pointDragStart(event)" ondragover="pointDragOver(event)" ondragleave="pointDragLeave(event)" ondrop="pointDrop(event)" ondragend="pointDragEnd(event)">
              <span class="badge ${typeClass}">${item.role}</span>
              <div>
                <div class="point-name-row">
                  <div class="point-name"${nameClick}>${escapeHtml(item.point.name)}</div>
                  ${item.kind === 'from' ? '' : `<span class="point-mode mode-${mode}" role="button" title="点击切换交通方式" onclick="cyclePointMode(${dayIndex},'${item.kind}',${item.waypointIndex ?? 'null'})">${escapeHtml(transportLabels[mode] || '车')}</span>`}
                </div>
              </div>
              <div class="point-actions">${editButtons}${moreRouteBtn}</div>
            </div>
            ${endSlotHtml}
            ${segmentHtml}`;
        }).join('');
        return `
          <section class="day">
            <div class="day-head">
              <div class="day-title">
                <div class="day-name-row">
                  <span class="day-index">D${dayIndex + 1}</span>
                  <input value="${escapeAttr(title)}" onchange="renameDay(${dayIndex}, this.value)" />
                </div>
              </div>
              <div class="day-actions">
                <span class="day-total">${formatTripMetric(dayDistance, dayDuration)}</span>
                ${currentRouteView === 'all' ? `<button class="small primary" data-add-day-after="${dayIndex}" title="新增一天">+</button>` : ''}
                <button class="small danger" title="删除" onclick="deleteDay(${dayIndex})">✕</button>
              </div>
            </div>
            <div class="points">${pointHtml}</div>
          </section>`;
      }).join('');
    }

    return {renderRouteSelect, renderDaySelect, renderDays};
  }

  window.RouteRenderer = {create};
})();
