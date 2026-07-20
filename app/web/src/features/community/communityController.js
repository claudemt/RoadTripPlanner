(function () {
  function create({
    el,
    localService,
    runtime,
    dialogs,
    escapeHtml,
    escapeAttr,
    toast,
    openLightbox,
  }) {
    let selfProfile = null;
    let profileResult = null;
    let messages = [];
    let replyTarget = null;
    let pollTimer = null;
    let removeAvatar = false;

    const timeText = (value) => {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch (_) { return ''; }
    };

    const avatarMarkup = (profile, extraClass = '') => profile?.avatarUrl
      ? `<span class="profile-avatar ${extraClass}"><img src="${escapeAttr(profile.avatarUrl)}" alt=""></span>`
      : `<span class="profile-avatar ${extraClass}"><span class="user-menu-icon" aria-hidden="true"></span></span>`;

    function renderAvatar(target, profile) {
      if (!target) return;
      target.classList.add('profile-avatar');
      target.innerHTML = profile?.avatarUrl
        ? `<img src="${escapeAttr(profile.avatarUrl)}" alt="">`
        : '<span class="user-menu-icon" aria-hidden="true"></span>';
    }

    function applyIdentity(profile) {
      if (!profile) return;
      selfProfile = profile;
      renderAvatar(el('headerProfileAvatar'), profile);
      renderAvatar(el('accountProfileAvatar'), profile);
      renderAvatar(el('profileEditorAvatar'), profile);
      const accountLabel = el('accountEmail');
      if (accountLabel) {
        accountLabel.textContent = profile.nickname;
        accountLabel.title = profile.email;
      }
      if (el('accountIdentityNickname')) el('accountIdentityNickname').textContent = profile.nickname;
      if (el('accountIdentityEmail')) el('accountIdentityEmail').textContent = profile.email;
      if (el('accountIdentityRole')) el('accountIdentityRole').textContent = profile.isAdmin ? '管理员' : '用户';
    }

    function contributionList(items, type) {
      if (!items?.length) return '<div class="profile-contribution-empty">暂无记录</div>';
      return items.map((item) => `
        <div class="profile-contribution-item">
          <strong>${escapeHtml(item.title || item.name || '未命名')}</strong>
          <span>${type === 'scene' ? `v${escapeHtml(item.version || 1)} · ` : ''}${escapeHtml(timeText(item.created_at || item.published_at))}</span>
        </div>
      `).join('');
    }

    function renderContributionBlocks(result, prefix = 'profile') {
      const contributions = result?.contributions || {};
      const summary = el(`${prefix}ContributionSummary`);
      const routes = el(`${prefix}RouteContributions`);
      const scenes = el(`${prefix}SceneContributions`);
      if (summary) {
        summary.innerHTML = `
          <div><strong>${escapeHtml(contributions.routeCount || 0)}</strong><span>公共路线</span></div>
          <div><strong>${escapeHtml(contributions.sceneRevisionCount || 0)}</strong><span>景点版本</span></div>
        `;
      }
      if (routes) routes.innerHTML = contributionList(contributions.routes, 'route');
      if (scenes) scenes.innerHTML = contributionList(contributions.scenes, 'scene');
    }

    function renderProfilePage(result) {
      if (!result?.profile) return;
      profileResult = result;
      const profile = result.profile;
      applyIdentity(profile);
      if (el('profilePageEmail')) el('profilePageEmail').textContent = profile.email;
      if (el('profileNicknameInput')) {
        el('profileNicknameInput').value = profile.nickname;
        el('profileNicknameInput').disabled = !result.editable;
      }
      if (el('profileBioInput')) {
        el('profileBioInput').value = profile.bio || '';
        el('profileBioInput').disabled = !result.editable;
      }
      const avatarInput = el('profileAvatarInput');
      if (avatarInput) {
        avatarInput.value = '';
        avatarInput.closest('label').hidden = !result.editable;
      }
      if (el('profileSaveBtn')) el('profileSaveBtn').hidden = !result.editable;
      if (el('profileRemoveAvatarBtn')) el('profileRemoveAvatarBtn').hidden = !result.editable || !profile.avatarUrl;
      el('profileEditor')?.classList.toggle('profile-fixed', !result.editable);
      removeAvatar = false;
      renderContributionBlocks(result);
    }

    async function refreshSelfProfile() {
      const {response, data} = await localService.getProfile();
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取个人资料');
      renderProfilePage(data);
      return data;
    }

    const readAsDataUrl = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });

    async function saveProfile() {
      const nickname = el('profileNicknameInput').value.trim();
      const bio = el('profileBioInput').value.trim();
      const file = el('profileAvatarInput').files?.[0] || null;
      if (!nickname) return toast('请填写昵称。');
      if (file && (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type) || file.size > 5 * 1024 * 1024)) {
        return toast('头像须为 5MB 以内的 PNG、JPEG、WebP 或 GIF。');
      }
      const payload = {nickname, bio, removeAvatar};
      if (file) payload.avatar = {name: file.name, type: file.type, dataUrl: await readAsDataUrl(file)};
      const {response, data} = await localService.saveProfile(payload);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '保存失败');
      renderProfilePage(data);
      toast('个人资料已保存。');
      await refreshMessages({quiet: true});
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function messageMarkup(item) {
      const profile = item.author || {};
      const quoted = item.replyTo ? `
        <div class="community-quote">
          <strong>${escapeHtml(item.replyTo.author?.nickname || item.replyTo.author?.email || '用户')}</strong>
          <span>${item.replyTo.withdrawn ? '消息已撤回' : escapeHtml(item.replyTo.body || '附件')}</span>
        </div>
      ` : '';
      const body = item.withdrawn
        ? '<div class="community-withdrawn">消息已撤回</div>'
        : (item.body ? `<div class="community-message-body">${escapeHtml(item.body).replace(/\n/g, '<br>')}</div>` : '');
      const attachments = item.withdrawn ? '' : (item.attachments || []).map((attachment) => attachment.isImage
        ? `<button class="community-image" type="button" data-image-url="${escapeAttr(attachment.url)}"><img src="${escapeAttr(attachment.url)}" alt="${escapeAttr(attachment.fileName)}"></button>`
        : `<a class="community-file" href="${escapeAttr(attachment.url)}" target="_blank" rel="noreferrer"><strong>${escapeHtml(attachment.fileName)}</strong><span>${escapeHtml(formatBytes(attachment.size))}</span></a>`
      ).join('');
      const actions = item.withdrawn ? '' : `
        <div class="community-message-actions">
          <button type="button" data-reply-id="${escapeAttr(item.id)}">引用</button>
          ${item.mine ? `<button type="button" data-withdraw-id="${escapeAttr(item.id)}">撤回</button>` : ''}
        </div>
      `;
      return `
        <article class="community-message ${item.mine ? 'mine' : ''}" data-message-id="${escapeAttr(item.id)}">
          <button class="community-author-avatar" type="button" data-profile-email="${escapeAttr(profile.email)}" title="查看个人介绍">
            ${avatarMarkup(profile)}
          </button>
          <div class="community-message-content">
            <header>
              <button type="button" data-profile-email="${escapeAttr(profile.email)}">${escapeHtml(profile.nickname || profile.email || '用户')}</button>
              <time>${escapeHtml(timeText(item.createdAt))}</time>
            </header>
            ${quoted}
            ${body}
            ${attachments ? `<div class="community-attachments">${attachments}</div>` : ''}
            ${actions}
          </div>
        </article>
      `;
    }

    async function refreshMessages({quiet = false} = {}) {
      const box = el('communityMessages');
      if (!box) return;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
      const {response, data} = await localService.listCommunityMessages(120);
      if (!response.ok || !data?.ok) {
        if (!quiet) box.innerHTML = `<div class="account-empty">读取社区消息失败：${escapeHtml(data?.message || '未知错误')}</div>`;
        return;
      }
      messages = data.messages || [];
      box.innerHTML = messages.length
        ? messages.map(messageMarkup).join('')
        : '<div class="account-empty">还没有消息。</div>';
      if (nearBottom || !quiet) box.scrollTop = box.scrollHeight;
    }

    function setReply(messageId) {
      replyTarget = messages.find((item) => item.id === messageId) || null;
      const preview = el('communityReplyPreview');
      if (!preview) return;
      preview.hidden = !replyTarget;
      if (replyTarget) {
        el('communityReplyText').textContent = `引用 ${replyTarget.author?.nickname || '用户'}：${replyTarget.withdrawn ? '消息已撤回' : (replyTarget.body || '附件').slice(0, 80)}`;
        el('communityMessageInput')?.focus();
      }
    }

    async function prepareAttachments(files) {
      if (files.length > 4) throw new Error('每条消息最多附加 4 个文件。');
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (files.some((file) => file.size > 20 * 1024 * 1024) || total > 50 * 1024 * 1024) {
        throw new Error('单个附件不能超过 20MB，总大小不能超过 50MB。');
      }
      const result = [];
      for (const file of files) {
        result.push({name: file.name, type: file.type || 'application/octet-stream', dataUrl: await readAsDataUrl(file)});
      }
      return result;
    }

    async function sendMessage() {
      const body = el('communityMessageInput').value.trim();
      const files = [...(el('communityAttachmentInput').files || [])];
      if (!body && !files.length) return toast('请输入消息或选择附件。');
      const attachments = await prepareAttachments(files);
      const {response, data} = await localService.postCommunityMessage({
        body,
        attachments,
        replyToId: replyTarget?.id || null,
      });
      if (!response.ok || !data?.ok) throw new Error(data?.message || '发送失败');
      el('communityMessageInput').value = '';
      el('communityAttachmentInput').value = '';
      el('communityAttachmentNames').textContent = '';
      setReply(null);
      await refreshMessages();
    }

    async function withdrawMessage(messageId) {
      if (!confirm('撤回这条消息？')) return;
      const {response, data} = await localService.withdrawCommunityMessage(messageId);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '撤回失败');
      await refreshMessages({quiet: true});
    }

    function profileBody(result) {
      const profile = result.profile;
      const contributions = result.contributions || {};
      return `
        <div class="profile-modal-profile">
          ${avatarMarkup(profile, 'profile-modal-avatar')}
          <div><h3>${escapeHtml(profile.nickname)}</h3><span>${escapeHtml(profile.email)}</span></div>
        </div>
        ${profile.bio ? `<p class="profile-modal-bio">${escapeHtml(profile.bio)}</p>` : ''}
        <div class="profile-modal-stats">
          <div><strong>${escapeHtml(contributions.routeCount || 0)}</strong><span>公共路线</span></div>
          <div><strong>${escapeHtml(contributions.sceneRevisionCount || 0)}</strong><span>景点版本</span></div>
        </div>
        <div class="profile-modal-contributions">
          <section><h4>公共路线</h4>${contributionList(contributions.routes, 'route')}</section>
          <section><h4>景点维护</h4>${contributionList(contributions.scenes, 'scene')}</section>
        </div>
      `;
    }

    async function openProfile(email) {
      const {response, data} = await localService.getProfile(email);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取个人介绍');
      el('profileModalBody').innerHTML = profileBody(data);
      dialogs.open('profileModal');
    }

    function startPolling() {
      stopPolling();
      refreshMessages();
      pollTimer = setInterval(() => refreshMessages({quiet: true}), 5000);
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    function activate(view) {
      if (view === 'profile') {
        refreshSelfProfile().catch((error) => toast('读取个人资料失败：' + error.message));
      }
      if (view === 'community') startPolling();
      else stopPolling();
    }

    function bind() {
      el('profileSaveBtn').onclick = () => saveProfile().catch((error) => toast('保存个人资料失败：' + error.message));
      el('profileRemoveAvatarBtn').onclick = () => {
        removeAvatar = true;
        el('profileAvatarInput').value = '';
        renderAvatar(el('profileEditorAvatar'), {avatarUrl: null});
      };
      el('profileAvatarInput').onchange = () => {
        const file = el('profileAvatarInput').files?.[0];
        if (!file) return;
        removeAvatar = false;
        const url = URL.createObjectURL(file);
        renderAvatar(el('profileEditorAvatar'), {avatarUrl: url});
      };
      el('communitySendBtn').onclick = () => sendMessage().catch((error) => toast('发送失败：' + error.message));
      el('communityCancelReplyBtn').onclick = () => setReply(null);
      el('communityAttachmentInput').onchange = () => {
        el('communityAttachmentNames').textContent = [...(el('communityAttachmentInput').files || [])].map((file) => file.name).join('、');
      };
      el('communityMessageInput').onkeydown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          sendMessage().catch((error) => toast('发送失败：' + error.message));
        }
      };
      el('communityMessages').onclick = (event) => {
        const image = event.target.closest('[data-image-url]');
        if (image) return openLightbox(image.dataset.imageUrl);
        const profile = event.target.closest('[data-profile-email]');
        if (profile) return openProfile(profile.dataset.profileEmail).catch((error) => toast(error.message));
        const reply = event.target.closest('[data-reply-id]');
        if (reply) return setReply(reply.dataset.replyId);
        const withdraw = event.target.closest('[data-withdraw-id]');
        if (withdraw) withdrawMessage(withdraw.dataset.withdrawId).catch((error) => toast(error.message));
      };
    }

    return {
      bind,
      activate,
      stopPolling,
      refreshSelfProfile,
      openProfile,
      getProfile: () => profileResult,
    };
  }

  window.CommunityController = {create};
})();
