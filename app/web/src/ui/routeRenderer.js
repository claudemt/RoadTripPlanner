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

    function renderRouteSelect({routeBook, route, archivedRoutes}) {
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
      const localNames = new Set(routeBook.routes.map((item) => item.name));
      const archivedOptions = (archivedRoutes || [])
        .filter((item) => item.routeJson && !localNames.has(item.name))
        .map((item) => `<option value="archive:${escapeAttr(item.safeName)}">导出：${escapeHtml(cleanRouteName(item.name) || item.safeName)}</option>`)
        .join('');
      el('routeSelect').innerHTML = localOptions + (archivedOptions ? `<optgroup label="已导出路线">${archivedOptions}</optgroup>` : '');
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
        const title = cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`;
      const pointHtml = points.map((item, pointIndex) => {
        const typeClass = item.role === '起' ? 'start' : item.role === '终' ? 'end' : 'waypoint';
        const mode = normalizeTransportMode(item.point.transportMode);
        const editButtons = item.kind === 'waypoint'
          ? `<button class="small primary" onclick="openPointEditor({mode:'insertAfter',dayIndex:${dayIndex},afterKind:'waypoint',waypointIndex:${item.waypointIndex}})">新增地点</button><button class="small" onclick="moveWaypoint(${dayIndex},${item.waypointIndex},-1)">上移</button><button class="small" onclick="moveWaypoint(${dayIndex},${item.waypointIndex},1)">下移</button><button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'waypoint',waypointIndex:${item.waypointIndex}})">编辑</button><button class="small danger" onclick="deleteWaypoint(${dayIndex},${item.waypointIndex})">删除</button>`
            : item.kind === 'from'
              ? `<button class="small primary" onclick="openPointEditor({mode:'insertAfter',dayIndex:${dayIndex},afterKind:'from'})">新增地点</button><button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'from'})">编辑</button>`
              : `<button class="small" onclick="openPointEditor({mode:'replace',dayIndex:${dayIndex},kind:'to'})">编辑</button>`;
          const segment = dayResult.segments[pointIndex];
          const segmentHtml = pointIndex < points.length - 1
            ? `<div class="segment ${segment && !segment.error ? 'ok' : segment?.error ? 'error' : ''}">↳ ${segment ? (segment.error ? escapeHtml(segment.error) : formatTripMetric(segment.distance, segment.duration)) : '尚未计算'}</div>`
            : '';
          const nameClick = item.point.useScenic === false
            ? ''
            : ` onclick="showSpotInfo('${escapeJsAttr(item.point.name)}')" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted"`;
          const scenicSkip = item.point.useScenic === false ? ' · 不采用景点说明' : '';
          const coordsTitle = `${fixed(item.point.lng)}, ${fixed(item.point.lat)}`;
          return `
            <div class="point">
              <span class="badge ${typeClass}">${item.role}</span>
              <div>
                <div class="point-name-row">
                  <div class="point-name"${nameClick}>${escapeHtml(item.point.name)}</div>
                  ${item.kind === 'from' ? '' : `<span class="point-mode mode-${mode}" role="button" title="点击切换交通方式" onclick="cyclePointMode(${dayIndex},'${item.kind}',${item.waypointIndex ?? 'null'})">${escapeHtml(transportLabels[mode] || '车')}</span>`}
                </div>
                ${scenicSkip ? `<div class="point-sub" title="${escapeAttr(coordsTitle)}">${scenicSkip}</div>` : ''}
              </div>
              <div class="point-actions">${editButtons}</div>
            </div>
            ${segmentHtml ? segmentHtml.replace('↳ ', `↳ ${escapeHtml(transportLabels[normalizeTransportMode(segment?.mode || points[pointIndex + 1]?.point?.transportMode)] || '车')} · `) : ''}`;
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
                ${currentRouteView === 'all' ? `<button class="small primary" data-add-day-after="${dayIndex}" title="在这一天后面新增一天">新增一天</button>` : ''}
                <button class="small danger" onclick="deleteDay(${dayIndex})">删除</button>
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
