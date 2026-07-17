const byId = (id) => document.getElementById(id);
const INTERNAL_ACCOUNT_DOMAIN = 'map.bestapi.best';

function displayAccountName(user, runtime) {
  if (runtime.mode === 'local') return '本地模式';
  const username = user?.user_metadata?.preferred_username || user?.user_metadata?.username || user?.user_metadata?.name;
  if (!user?.email) return username || '访客预览';
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
    modeElement.textContent = runtime.mode === 'cloud'
      ? `云端同步 · ${runtime.config.identityLabel || 'Cloud-IAM'}`
      : runtime.mode === 'local'
        ? '本地高级版'
        : '本地草稿';
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
  const loginForm = byId('identityLoginForm');
  const previewButton = byId('previewModeBtn');
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
  loginForm.hidden = false;

  return new Promise((resolve) => {
    loginForm.onsubmit = async (event) => {
      event.preventDefault();
      setBusy(true);
      setMessage('正在打开登录页…', 'notice');
      const {error: loginError} = await runtime.supabase.auth.signInWithOAuth({
        provider: runtime.config.oidcProvider || 'custom:cloud-iam',
        options: {
          redirectTo: `${location.origin}/`,
        },
      });
      setBusy(false);
      if (loginError) return setMessage(loginError.message, 'error');
      resolve({user: null});
    };
  });
}
