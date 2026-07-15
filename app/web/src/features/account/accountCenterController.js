(function () {
  const statusLabels = {
    queued: '等待中',
    running: '生成中',
    cancel_requested: '正在取消',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  const formatTime = (value) => {
    if (!value) return '尚未更新';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {hour12: false});
  };

  const views = {
    routes: {
      eyebrow: 'ROUTES',
      title: '我的路线',
      subtitle: '按最近更新时间排列，只显示当前账户保存的路线。',
    },
    exports: {
      eyebrow: 'EXPORTS',
      title: '导出文件',
      subtitle: '查看后台生成进度，并打开路线图、手册、PDF 与 MP4。',
    },
    settings: {
      eyebrow: 'ACCOUNT',
      title: '账户设置',
      subtitle: '管理当前登录状态和站点服务信息。',
    },
  };

  function create({el, localService, runtime, escapeHtml, escapeAttr, toast, loadRoute}) {
    let refreshTimer = null;
    let activeView = 'routes';

    function setView(view) {
      activeView = views[view] ? view : 'routes';
      document.querySelectorAll('[data-account-view]').forEach((button) => {
        const selected = button.dataset.accountView === activeView;
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      el('myRoutesView').hidden = activeView !== 'routes';
      el('myExportsView').hidden = activeView !== 'exports';
      el('mySettingsView').hidden = activeView !== 'settings';
      el('accountPageEyebrow').textContent = views[activeView].eyebrow;
      el('accountPageTitle').textContent = views[activeView].title;
      el('accountPageSubtitle').textContent = views[activeView].subtitle;
    }

    function renderRoutes(routes) {
      const list = el('myRoutesList');
      el('myRouteCount').textContent = String(routes.length);
      if (!routes.length) {
        list.innerHTML = '<div class="account-empty">还没有保存路线。返回地图后可以新建第一条路线。</div>';
        return;
      }
      list.innerHTML = routes.map((route) => `
        <article class="account-item route-account-item">
          <div class="account-item-main">
            <strong>${escapeHtml(route.name || '未命名路线')}</strong>
            <span>${Number(route.routeData?.days?.length || 0)} 天行程</span>
          </div>
          <time class="account-item-time">${formatTime(route.updatedAt || route.archivedAt)}</time>
          <button class="small primary" data-load-route="${escapeAttr(route.safeName)}">打开</button>
        </article>
      `).join('');
      list.querySelectorAll('[data-load-route]').forEach((button) => {
        button.onclick = async () => {
          await loadRoute(button.dataset.loadRoute);
          close();
        };
      });
    }

    function artifactButtons(job) {
      return (job.artifacts || []).map((artifact) => `
        <button class="small" data-export-path="${escapeAttr(artifact.path)}">
          ${escapeHtml(artifact.label || artifact.fileName || '下载')}
        </button>
      `).join('');
    }

    function renderExports(exports) {
      const list = el('myExportsList');
      el('myExportCount').textContent = String(exports.length);
      if (!exports.length) {
        list.innerHTML = '<div class="account-empty">还没有导出记录。路线编辑完成后点击“导出”即可创建。</div>';
        return;
      }
      list.innerHTML = exports.map((job) => {
        const active = ['queued', 'running', 'cancel_requested'].includes(job.status);
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        return `
          <article class="account-item export-account-item">
            <div class="account-item-main">
              <strong>${escapeHtml(job.route_name || '未命名路线')}</strong>
              <span>${formatTime(job.created_at)} · ${job.render_video ? '全量导出（含 MP4）' : '文档导出'}</span>
            </div>
            <span class="export-state state-${escapeHtml(job.status)}">${statusLabels[job.status] || escapeHtml(job.status)}</span>
            <div class="account-item-actions">
              ${(job.artifacts || []).length ? artifactButtons(job) : '<span class="account-no-files">尚无文件</span>'}
            </div>
            ${active ? `
              <div class="account-progress" aria-label="导出进度">
                <span style="width:${progress}%"></span>
              </div>
              <p class="account-item-message">${escapeHtml(job.message || job.phase || '处理中')} · ${progress}%</p>
            ` : ''}
            ${job.error ? `<p class="account-item-error">${escapeHtml(job.error)}</p>` : ''}
          </article>
        `;
      }).join('');

      list.querySelectorAll('[data-export-path]').forEach((button) => {
        button.onclick = async () => {
          const popup = window.open('', '_blank');
          try {
            const {response, data} = await localService.getExportArtifactUrl(button.dataset.exportPath);
            if (!response.ok || !data?.ok) throw new Error(data?.message || '无法创建下载链接');
            if (popup) popup.location.href = data.url;
            else location.href = data.url;
          } catch (error) {
            popup?.close();
            toast('打开导出文件失败：' + error.message);
          }
        };
      });
    }

    async function refresh() {
      if (!localService.capabilities?.cloudRoutes) return;
      const [routesResult, exportsResult] = await Promise.all([
        localService.listRoutes(),
        localService.listExports(),
      ]);
      if (routesResult.response.ok && routesResult.data?.ok) {
        renderRoutes(routesResult.data.routes || []);
      } else {
        el('myRoutesList').innerHTML = `<div class="account-empty">读取路线失败：${escapeHtml(routesResult.data?.message || '请稍后重试')}</div>`;
      }
      if (exportsResult.response.ok && exportsResult.data?.ok) {
        renderExports(exportsResult.data.exports || []);
      } else {
        el('myExportsList').innerHTML = `<div class="account-empty">读取导出记录失败：${escapeHtml(exportsResult.data?.message || '请稍后重试')}</div>`;
      }
    }

    function startPolling() {
      stopPolling();
      refreshTimer = window.setInterval(refresh, 3000);
    }

    function stopPolling() {
      if (refreshTimer) window.clearInterval(refreshTimer);
      refreshTimer = null;
    }

    async function open(view = 'routes') {
      setView(view);
      el('accountCenter').classList.add('open');
      el('accountCenter').setAttribute('aria-hidden', 'false');
      document.body.classList.add('account-mode');
      await refresh();
      startPolling();
    }

    function close() {
      el('accountCenter').classList.remove('open');
      el('accountCenter').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('account-mode');
      stopPolling();
    }

    const accountName = runtime?.user?.user_metadata?.preferred_username
      || runtime?.user?.user_metadata?.username
      || runtime?.user?.user_metadata?.name
      || runtime?.user?.email
      || '当前账户';
    el('accountProfileEmail').textContent = accountName;
    el('accountSettingsEmail').textContent = accountName;
    el('accountInitial').textContent = accountName.slice(0, 1).toUpperCase();

    document.querySelectorAll('[data-account-view]').forEach((button) => {
      button.onclick = () => setView(button.dataset.accountView);
    });
    el('accountCenterClose').onclick = close;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && el('accountCenter').classList.contains('open')) close();
    });

    return {open, close, refresh, setView};
  }

  window.AccountCenterController = {create};
})();
