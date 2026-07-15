# RoadTripPlanner 网站迁移工作记录

本文记录项目从本地静态网页迁移为 EdgeOne + Supabase 网站的完整过程。文档不保存任何 API Key、数据库密码或 Service Role Key。

## 1. 当前架构

```text
浏览器
  |
  |-- EdgeOne Pages
  |     - 登录封面
  |     - 路线规划与高德地图
  |     - 独立个人工作台
  |
  |-- Supabase
  |     - 邮箱登录
  |     - 用户路线
  |     - 共享景点资料
  |     - 导出任务队列
  |     - 私有导出文件
  |
  `-- Docker 渲染服务
        - Chromium
        - Remotion
        - ffmpeg
        - PDF/MP4 生成与上传
```

EdgeOne 负责静态前端和自定义域名。Supabase 负责身份、数据库和对象存储。视频渲染需要独立常驻服务，因为一次 MP4 渲染通常不适合放进短时云函数。

## 2. Git 与分支

- GitHub 仓库：`claudemt/RoadTripPlanner`
- 网站开发分支：`codex/edgeone-web`
- EdgeOne 生产分支：`codex/edgeone-web`
- 不在主分支直接修改。

关键存档：

- `5f04848`：准备 EdgeOne 网站部署
- `d836a68`：加入云端导出队列、私有文件和个人中心

常用命令：

```powershell
git switch codex/edgeone-web
git status
git add <本次修改>
git commit -m "说明"
git push origin codex/edgeone-web
```

推送后 EdgeOne 会自动构建并部署。

## 3. 目录职责

```text
RoadTripPlanner/
├─ start.bat                    # 本地高级版启动入口
├─ work.md                      # 网站迁移与运维记录
├─ app/
│  ├─ web/                     # EdgeOne 前端
│  ├─ server/                  # 本地导出与渲染 HTTP 服务
│  ├─ video/                   # Remotion 视频工程
│  ├─ worker/                  # 云端 Docker 渲染服务
│  └─ cloud/supabase/          # Supabase SQL 迁移
└─ data/                       # 本地路线、景点和私有配置
```

根目录继续保留本地启动脚本。网站代码、服务端代码和数据库迁移均归入 `app/`。

## 4. 从静态页面到模块化前端

原始 `index.html` 同时承担页面结构、地图调用、路线状态、导出和景点管理，后续已拆分为：

- `web/src/api/`：本地与云端服务接口
- `web/src/auth/`：邮箱登录与会话
- `web/src/domain/`：路线模型
- `web/src/features/`：路线、地图、景点、导出、个人工作台
- `web/src/map/`：地图厂商适配层
- `web/src/state/`：本地路线状态
- `web/src/ui/`：渲染和反馈
- `web/src/utils/`：通用工具

地图调用通过 Provider 接口隔离。当前实现使用高德地图，后续兼容其他地图厂商时，应新增 Provider，不要把厂商调用重新写回页面控制器。

## 5. 网站界面

网站包含三个主要状态：

1. 登录封面：邮箱 Magic Link / OTP 登录。
2. 路线工作区：地图和紧凑左侧路线编辑栏。
3. 个人工作台：点击地图页头像进入，采用独立全屏界面。

个人工作台包含：

- 我的路线：打开当前账户保存的路线。
- 导出文件：查看任务状态，打开 JSON、路线图、Markdown、PDF 和 MP4。
- 账户设置：查看邮箱、数据范围、站点服务状态并退出登录。

网站端高德 Key 由 EdgeOne 环境变量统一提供，普通用户看不到也不需要填写“配置”。本地高级版仍可从本机配置文件读取 Key。

## 6. Supabase

项目：

- Project Ref：`ljwgddzzfucspkauqdjj`
- URL：`https://ljwgddzzfucspkauqdjj.supabase.co`

已执行迁移：

1. `app/cloud/supabase/migrations/001_initial_schema.sql`
2. `app/cloud/supabase/migrations/002_cloud_exports.sql`

主要数据：

- `routes`：用户私有路线，RLS 按 `user_id` 隔离。
- `scenes`：所有登录用户共同维护的景点介绍。
- `scene_revisions`：景点修改记录。
- `export_jobs`：后台导出任务。
- `scene-images`：公开景点图片桶。
- `route-exports`：用户私有导出桶。

`route-exports` 的对象路径以用户 UUID 开头，读取策略只允许当前用户访问自己的目录。浏览器通过短时 Signed URL 打开文件。

### 邮箱登录配置

Supabase Dashboard 中进入：

```text
Authentication -> URL Configuration
```

正式域名生效后设置：

```text
Site URL: https://map.bestapi.best/
Redirect URL: https://map.bestapi.best/**
```

2026-07-15 配置时 Supabase Dashboard 显示技术故障公告，保存请求未成功，当前仍是 `http://localhost:3000`。`map.bestapi.best` 生效后必须重新保存。

默认 Supabase 邮件适合早期测试。正式开放给用户前，建议接入自有 SMTP，提高发信额度、送达率和品牌一致性。

## 7. EdgeOne

项目：

- Project ID：`makers-bpznidn1mvq4`
- 生产分支：`codex/edgeone-web`
- 最新已验证部署：`dpwml06xrxda`

EdgeOne 环境变量：

```text
VITE_SITE_NAME
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_AMAP_KEY
VITE_AMAP_SECURITY_JS_CODE
```

这些变量用于浏览器端。不要把 Supabase `service_role` Key 放进任何 `VITE_` 变量。

构建配置：

```text
Root directory: app
Build command: npm run build
Output directory: dist
```

## 8. 自定义域名

目标域名：

```text
https://map.bestapi.best/
```

EdgeOne 已添加该域名，所有权验证已通过，CNAME 已被 EdgeOne 识别为 Effective。DNS 需要保留：

```text
Type: CNAME
Host: map
Value: map.bestapi.best.pages.dnsoe8.com
```

CNAME 生效后：

1. 回到 EdgeOne Domains。
2. 确认 `map.bestapi.best` 状态为 Effective。
3. 配置 Edge HTTPS certificate。
4. 开启 Force HTTPS。
5. 确认 `http://map.bestapi.best/` 自动跳转到 HTTPS。
6. 把 `map.bestapi.best` 加入高德 Web JS API 域名白名单。

腾讯云国际站当前还提示 `Incomplete Account Information`。需先完成账户资料，才能稳定使用自定义域名和后续云服务器。

## 9. 全量导出与视频

浏览器提交导出时，只向 `export_jobs` 写入任务，不等待视频渲染。个人工作台每 3 秒刷新任务状态。

渲染服务位于：

```text
app/worker/
├─ Dockerfile
├─ README.md
└─ render-worker.js
```

渲染机需要的服务器环境变量：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
AMAP_KEY
AMAP_SECURITY_JS_CODE
```

启动方式：

```bash
cd app
docker build -f worker/Dockerfile -t roadtrip-render-worker .
docker run -d --restart unless-stopped \
  --name roadtrip-render-worker \
  --env-file worker.env \
  roadtrip-render-worker
```

容器不需要开放入站端口，只需要访问 Supabase 和高德。建议使用一台小型 Linux 云服务器，并至少预留 2 vCPU、4 GB 内存和足够的临时磁盘。

渲染流程：

1. 使用 Service Role 调用 `claim_next_export_job`。
2. 在隔离临时目录启动本地渲染服务。
3. 生成路线 JSON、视频数据、路线图、Markdown、PDF。
4. 用户勾选视频时，使用 Remotion + Chromium + ffmpeg 生成 MP4。
5. 使用 TUS 分片上传到私有 `route-exports` 桶。
6. 更新任务状态和文件清单。
7. 清理临时目录。

每个用户只能有一个活动导出任务。排队任务可以立即取消；运行任务由渲染服务响应取消请求。

## 10. 发布检查

每次提交前执行：

```powershell
cd app
npm install
npm run build
npm run typecheck
node --check worker/render-worker.js
git diff --check
```

发布后检查：

- 登录封面显示“邮箱登录”，不是“静态预览”。
- 地图页不显示用户填写高德 Key 的入口。
- 头像可以进入独立个人工作台。
- 路线只显示当前用户的数据。
- 景点信息可由登录用户共同修改。
- 导出任务可查看进度、取消和打开文件。
- EdgeOne 部署状态为 Success。
- 自定义域名、HTTPS、Supabase 回跳和高德白名单均已生效。

## 11. 密钥与备份

- 浏览器只使用 Supabase Publishable Key。
- Service Role Key 只放在渲染服务器。
- 本地私有配置保存在已忽略的 `data/config/local.env`。
- 不提交 `worker.env`、数据库密码、SMTP 密码或云服务器私钥。
- Supabase SQL 迁移必须保留在 Git 中，确保数据库结构可重建。
