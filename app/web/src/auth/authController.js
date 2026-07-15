const byId = (id) => document.getElementById(id);
const INTERNAL_ACCOUNT_DOMAIN = 'map.bestapi.best';

function usernameToEmail(username) {
  const value = String(username || '').trim().toLowerCase();
  if (!value) return '';
  return value.includes('@') ? value : `${value}@${INTERNAL_ACCOUNT_DOMAIN}`;
}

function displayAccountName(user, runtime) {
  if (runtime.mode === 'local') return '本地模式';
  if (!user?.email) return '访客预览';
  const email = String(user.email).toLowerCase();
  const suffix = `@${INTERNAL_ACCOUNT_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : user.email;
}

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
  const email = displayAccountName(user, runtime);
  document.body.classList.toggle('cloud-mode', runtime.mode === 'cloud');
  const emailElement = byId('accountEmail');
  if (emailElement) emailElement.textContent = email;
  const modeElement = byId('accountMode');
  if (modeElement) {
    modeElement.textContent = runtime.mode === 'cloud' ? '云端同步' : runtime.mode === 'local' ? '本地高级版' : '本地草稿';
  }

  const signOutButton = byId('signOutBtn');
  const accountButton = byId('openAccountBtn');
  if (accountButton) {
    accountButton.hidden = runtime.mode !== 'cloud';
    accountButton.title = user?.email ? `个人工作台 · ${email}` : '个人工作台';
  }
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
  const loginForm = byId('passwordLoginForm');
  const resetForm = byId('passwordResetForm');
  const newPasswordForm = byId('newPasswordForm');
  const usernameInput = byId('loginUsername');
  const passwordInput = byId('loginPassword');
  const resetEmailInput = byId('resetEmail');
  const newPasswordInput = byId('newPassword');
  const previewButton = byId('previewModeBtn');
  const forgotButton = byId('forgotPasswordBtn');
  const backButton = byId('backToLoginBtn');
  const siteName = byId('authSiteName');
  const localHost = ['127.0.0.1', 'localhost'].includes(location.hostname);

  if (siteName) siteName.textContent = runtime.config.siteName;

  if (runtime.mode === 'local') {
    enterWorkspace(runtime, null);
    return {user: null};
  }

  if (runtime.mode === 'preview') {
    gate?.classList.add('preview-mode');
    byId('authEyebrow').textContent = 'STATIC PREVIEW';
    byId('authSubmitBtn').hidden = true;
    loginForm.hidden = true;
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
  const recoveryMode = /(?:[?#&])type=recovery(?:&|$)/.test(`${location.search}${location.hash}`);
  if (existingUser && recoveryMode) {
    gate.hidden = false;
    loginForm.hidden = true;
    resetForm.hidden = true;
    newPasswordForm.hidden = false;
    document.querySelector('.auth-login-heading span').textContent = '重设密码';
    document.querySelector('.auth-login-heading small').textContent = '保存后进入路线';
    setMessage('请设置一个新密码。', 'notice');
    return new Promise((resolve) => {
      newPasswordForm.onsubmit = async (event) => {
        event.preventDefault();
        const password = newPasswordInput.value;
        if (password.length < 6) return setMessage('密码至少 6 位。', 'error');
        setBusy(true);
        setMessage('正在保存新密码…', 'notice');
        const {data: updateData, error: updateError} = await runtime.supabase.auth.updateUser({password});
        setBusy(false);
        if (updateError) return setMessage(updateError.message, 'error');
        const user = updateData?.user || existingUser;
        history.replaceState({}, document.title, `${location.origin}${location.pathname}`);
        setMessage('密码已更新，正在进入路线工作台。', 'success');
        enterWorkspace(runtime, user, true);
        resolve({user});
      };
    });
  }
  if (existingUser) {
    enterWorkspace(runtime, existingUser);
    return {user: existingUser};
  }

  gate.hidden = false;
  loginForm.hidden = false;
  resetForm.hidden = true;
  newPasswordForm.hidden = true;

  return new Promise((resolve) => {
    loginForm.onsubmit = async (event) => {
      event.preventDefault();
      const email = usernameToEmail(usernameInput.value);
      const password = passwordInput.value;
      if (!email || !password) return setMessage('请填写用户名和密码。', 'error');

      setBusy(true);
      setMessage('正在登录…', 'notice');
      const {data: loginData, error: loginError} = await runtime.supabase.auth.signInWithPassword({
        email,
        password,
      });
      setBusy(false);
      if (loginError) return setMessage('用户名或密码不正确。', 'error');

      const user = loginData?.user || loginData?.session?.user;
      setMessage('登录成功，正在展开路线工作台。', 'success');
      enterWorkspace(runtime, user, true);
      resolve({user});
    };

    resetForm.onsubmit = async (event) => {
      event.preventDefault();
      const email = resetEmailInput.value.trim();
      if (!email) return setMessage('请填写用于找回密码的邮箱。', 'error');
      setBusy(true);
      setMessage('正在发送找回邮件…', 'notice');
      const {error: resetError} = await runtime.supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/`,
      });
      setBusy(false);
      if (resetError) return setMessage(resetError.message, 'error');
      setMessage('找回密码邮件已发送，请查看邮箱。', 'success');
    };

    forgotButton.onclick = () => {
      loginForm.hidden = true;
      resetForm.hidden = false;
      setMessage('');
      resetEmailInput.focus();
    };

    backButton.onclick = () => {
      resetForm.hidden = true;
      loginForm.hidden = false;
      setMessage('');
      usernameInput.focus();
    };
  });
}
