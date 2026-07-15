const byId = (id) => document.getElementById(id);

function setMessage(message, type = '') {
  const target = byId('authMessage');
  if (!target) return;
  target.textContent = message || '';
  target.dataset.type = type;
}

function setBusy(busy) {
  document.querySelectorAll('#authGate button, #authGate input').forEach((element) => {
    element.disabled = busy;
  });
  byId('authGate')?.classList.toggle('is-busy', busy);
}

function renderAccount(runtime, user) {
  const email = user?.email || (runtime.mode === 'local' ? '本地模式' : '访客预览');
  const emailElement = byId('accountEmail');
  if (emailElement) emailElement.textContent = email;
  const modeElement = byId('accountMode');
  if (modeElement) {
    modeElement.textContent = runtime.mode === 'cloud' ? '云端同步' : runtime.mode === 'local' ? '本地高级版' : '本地草稿';
  }

  const signOutButton = byId('signOutBtn');
  const accountButton = byId('openAccountBtn');
  if (accountButton) accountButton.hidden = runtime.mode !== 'cloud';
  if (!signOutButton) return;
  signOutButton.hidden = runtime.mode !== 'cloud';
  signOutButton.onclick = async () => {
    signOutButton.disabled = true;
    await runtime.supabase?.auth.signOut();
    location.reload();
  };
}

function enterWorkspace(runtime, user, animated = false) {
  renderAccount(runtime, user);
  document.body.classList.add('app-ready');
  const gate = byId('authGate');
  if (!gate) return;
  if (animated) {
    gate.classList.add('is-leaving');
    window.setTimeout(() => {
      gate.hidden = true;
    }, 900);
  } else {
    gate.hidden = true;
  }
}

export async function initAuthGate(runtime) {
  const gate = byId('authGate');
  const emailForm = byId('emailLoginForm');
  const otpForm = byId('otpLoginForm');
  const emailInput = byId('loginEmail');
  const otpInput = byId('loginOtp');
  const previewButton = byId('previewModeBtn');
  const backButton = byId('backToEmailBtn');
  const siteName = byId('authSiteName');
  const localHost = ['127.0.0.1', 'localhost'].includes(location.hostname);
  let pendingEmail = '';

  if (siteName) siteName.textContent = runtime.config.siteName;

  if (runtime.mode === 'local') {
    enterWorkspace(runtime, null);
    return {user: null};
  }

  if (runtime.mode === 'preview') {
    gate?.classList.add('preview-mode');
    byId('authEyebrow').textContent = 'STATIC PREVIEW';
    byId('authSubmitBtn').hidden = true;
    emailForm.hidden = true;
    document.querySelector('.auth-login-heading span').textContent = '部署预览';
    document.querySelector('.auth-login-heading small').textContent = '尚未连接云端';
    setMessage(
      localHost
        ? '尚未配置 Supabase。可先预览界面，正式部署时在 EdgeOne 填写环境变量。'
        : '站点尚未完成云端配置，请联系管理员。',
      'notice',
    );
    previewButton.hidden = !localHost;
    return new Promise((resolve) => {
      previewButton.onclick = () => {
        enterWorkspace(runtime, null, true);
        resolve({user: null});
      };
    });
  }

  const {data, error} = await runtime.supabase.auth.getSession();
  if (error) setMessage(error.message, 'error');
  const existingUser = data?.session?.user;
  if (existingUser) {
    enterWorkspace(runtime, existingUser);
    return {user: existingUser};
  }

  gate.hidden = false;
  emailForm.hidden = false;
  otpForm.hidden = true;

  return new Promise((resolve) => {
    emailForm.onsubmit = async (event) => {
      event.preventDefault();
      pendingEmail = emailInput.value.trim();
      if (!pendingEmail) return setMessage('请先填写邮箱地址。', 'error');

      setBusy(true);
      setMessage('正在发送登录邮件…', 'notice');
      const {error: sendError} = await runtime.supabase.auth.signInWithOtp({
        email: pendingEmail,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${location.origin}/`,
        },
      });
      setBusy(false);
      if (sendError) return setMessage(sendError.message, 'error');

      byId('otpEmail').textContent = pendingEmail;
      emailForm.hidden = true;
      otpForm.hidden = false;
      otpInput.focus();
      setMessage('登录邮件已经发送。可点击邮件中的登录链接，或输入验证码。', 'success');
    };

    otpForm.onsubmit = async (event) => {
      event.preventDefault();
      const token = otpInput.value.replace(/\s/g, '');
      if (!/^\d{6,8}$/.test(token)) return setMessage('请输入邮件中的验证码。', 'error');

      setBusy(true);
      setMessage('正在验证…', 'notice');
      const {data: verifyData, error: verifyError} = await runtime.supabase.auth.verifyOtp({
        email: pendingEmail,
        token,
        type: 'email',
      });
      setBusy(false);
      if (verifyError) return setMessage(verifyError.message, 'error');

      const user = verifyData?.user || verifyData?.session?.user;
      setMessage('登录成功，正在展开路线工作台。', 'success');
      enterWorkspace(runtime, user, true);
      resolve({user});
    };

    backButton.onclick = () => {
      otpForm.hidden = true;
      emailForm.hidden = false;
      otpInput.value = '';
      setMessage('');
      emailInput.focus();
    };
  });
}
