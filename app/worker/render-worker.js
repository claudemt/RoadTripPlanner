const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {createClient} = require('@supabase/supabase-js');
const tus = require('tus-js-client');

const APP_ROOT = path.resolve(__dirname, '..');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const WORKER_ID = String(process.env.RENDER_WORKER_ID || os.hostname() || 'roadtrip-worker');
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.RENDER_POLL_INTERVAL_MS || 5000));
const AMAP_KEY = String(process.env.AMAP_KEY || process.env.REMOTION_AMAP_KEY || '');
const AMAP_SECURITY_JS_CODE = String(
  process.env.AMAP_SECURITY_JS_CODE || process.env.REMOTION_AMAP_SECURITY_CODE || '',
);
const EXPORT_BUCKET = 'route-exports';
const SERVER_PORT = Number(process.env.WORKER_RENDER_PORT || 6137);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}
if (!AMAP_KEY || !AMAP_SECURITY_JS_CODE) {
  throw new Error('AMAP_KEY and AMAP_SECURITY_JS_CODE are required');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {persistSession: false, autoRefreshToken: false},
});

let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const updateJob = async (jobId, patch) => {
  const {error} = await supabase.from('export_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
};

const claimJob = async () => {
  const {data, error} = await supabase.rpc('claim_next_export_job', {p_worker_id: WORKER_ID});
  if (error) throw error;
  return data?.[0] || null;
};

const isCancelRequested = async (jobId) => {
  const {data, error} = await supabase.from('export_jobs').select('status').eq('id', jobId).single();
  if (error) throw error;
  return data?.status === 'cancel_requested';
};

const markCancelled = (jobId) => updateJob(jobId, {
  status: 'cancelled',
  phase: 'cancelled',
  message: '导出已取消',
  error: null,
  completed_at: new Date().toISOString(),
});

const waitForServer = async (child, logText) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`渲染服务提前退出：${logText().slice(-2000)}`);
    }
    try {
      const response = await fetch(`${SERVER_URL}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('渲染服务启动超时');
};

const contentTypeFor = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/markdown;charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
};

const uploadFile = (objectName, filePath, onProgress) =>
  new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const upload = new tus.Upload(fs.createReadStream(filePath), {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      uploadSize: stat.size,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      removeFingerprintOnSuccess: true,
      headers: {
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'x-upsert': 'true',
      },
      metadata: {
        bucketName: EXPORT_BUCKET,
        objectName,
        contentType: contentTypeFor(filePath),
        cacheControl: '3600',
      },
      onError: reject,
      onProgress: (uploaded, total) => onProgress?.(total ? uploaded / total : 0),
      onSuccess: () => resolve({
        path: objectName,
        fileName: path.basename(filePath),
        mimeType: contentTypeFor(filePath),
        size: stat.size,
      }),
    });
    upload.findPreviousUploads()
      .then((previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(reject);
  });

const collectArtifacts = (result) => [
  ['route-json', '路线 JSON', result.routeJson],
  ['video-data', '视频数据', result.videoJson],
  ['route-map', '路线总览图', result.routeMapImage],
  ['travel-md', '路线手册 Markdown', result.manualMd],
  ['travel-pdf', '路线手册 PDF', result.manualPdf],
  ['video-mp4', '路线视频 MP4', result.output],
].filter(([, , filePath]) => filePath && fs.existsSync(filePath));

const renderJob = async (job) => {
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), `roadtrip-${job.id}-`));
  let child = null;
  let logs = '';
  let progressTimer = null;
  let cancelTimer = null;

  try {
    child = spawn(process.execPath, ['server/route-render-server.js'], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ROADTRIP_DATA_ROOT: jobRoot,
        AMAP_ROUTE_PORT: String(SERVER_PORT),
        AMAP_ROUTE_HOST: '127.0.0.1',
        REMOTION_AMAP_KEY: AMAP_KEY,
        REMOTION_AMAP_SECURITY_CODE: AMAP_SECURITY_JS_CODE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog = (chunk) => {
      logs += chunk.toString();
      if (logs.length > 120000) logs = logs.slice(-120000);
    };
    child.stdout.on('data', appendLog);
    child.stderr.on('data', appendLog);

    await waitForServer(child, () => logs);

    let lastProgress = 1;
    progressTimer = setInterval(async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/export-progress?t=${Date.now()}`);
        const state = await response.json();
        const progress = state?.progress || {};
        lastProgress = Math.max(lastProgress, Math.min(88, Math.round(Number(progress.percent || 1))));
        await updateJob(job.id, {
          phase: progress.phase || 'render',
          message: progress.message || '正在生成导出内容',
          progress: lastProgress,
        });
      } catch (_) {}
    }, 2000);

    cancelTimer = setInterval(async () => {
      try {
        const {data} = await supabase.from('export_jobs').select('status').eq('id', job.id).single();
        if (data?.status === 'cancel_requested') {
          await fetch(`${SERVER_URL}/api/export-cancel`, {method: 'POST'});
        }
      } catch (_) {}
    }, 2500);

    const payload = {
      ...(job.request_payload || {}),
      config: {key: AMAP_KEY, securityJsCode: AMAP_SECURITY_JS_CODE},
    };
    const response = await fetch(`${SERVER_URL}/api/export-route`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result?.ok) {
      const cancelled = result?.code === 'EXPORT_CANCELLED';
      await updateJob(job.id, {
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'error',
        message: cancelled ? '导出已取消' : '导出失败',
        progress: cancelled ? lastProgress : 100,
        error: cancelled ? null : String(result?.message || '渲染服务返回失败').slice(0, 4000),
        completed_at: new Date().toISOString(),
      });
      return;
    }

    clearInterval(progressTimer);
    progressTimer = null;
    if (await isCancelRequested(job.id)) {
      await markCancelled(job.id);
      return;
    }
    await updateJob(job.id, {
      phase: 'upload',
      message: '正在上传导出内容',
      progress: 90,
    });

    const sourceArtifacts = collectArtifacts(result);
    const artifacts = [];
    for (let index = 0; index < sourceArtifacts.length; index += 1) {
      if (await isCancelRequested(job.id)) {
        if (artifacts.length) {
          await supabase.storage.from(EXPORT_BUCKET).remove(artifacts.map((item) => item.path));
        }
        await markCancelled(job.id);
        return;
      }
      const [type, label, filePath] = sourceArtifacts[index];
      const objectName = `${job.user_id}/${job.id}/${path.basename(filePath)}`;
      const uploaded = await uploadFile(objectName, filePath, async (ratio) => {
        const fileStart = 90 + (index / sourceArtifacts.length) * 9;
        const fileSpan = 9 / sourceArtifacts.length;
        const progress = Math.min(99, Math.round(fileStart + ratio * fileSpan));
        await updateJob(job.id, {phase: 'upload', message: `正在上传${label}`, progress}).catch(() => {});
      });
      artifacts.push({type, label, ...uploaded});
    }

    if (await isCancelRequested(job.id)) {
      if (artifacts.length) {
        await supabase.storage.from(EXPORT_BUCKET).remove(artifacts.map((item) => item.path));
      }
      await markCancelled(job.id);
      return;
    }
    await updateJob(job.id, {
      status: 'completed',
      phase: 'done',
      message: '导出完成',
      progress: 100,
      artifacts,
      error: null,
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    await updateJob(job.id, {
      status: 'failed',
      phase: 'error',
      message: '导出失败',
      progress: 100,
      error: `${error.message}\n${logs.slice(-3000)}`.slice(0, 6000),
      completed_at: new Date().toISOString(),
    }).catch(() => {});
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (cancelTimer) clearInterval(cancelTimer);
    if (child && child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(jobRoot, {recursive: true, force: true});
  }
};

const run = async () => {
  console.log(`RoadTrip render worker started: ${WORKER_ID}`);
  while (!stopping) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      console.log(`Rendering export job ${job.id}: ${job.route_name}`);
      await renderJob(job);
    } catch (error) {
      console.error(error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
