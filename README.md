# RoadTripPlanner 使用说明

RoadTripPlanner 是一个自驾路线规划和行程资料整理工具。它可以作为本地高级工具使用，也可以部署成多人访问的网站：用户通过 Cloud-IAM 登录，路线保存在自己的 Supabase 账号下，景点介绍由登录用户共同维护，站点地图 Key 由 admin 统一配置。

完整上线步骤见：[部署手册](docs/deployment_manual.md)。

## 本地启动

安装依赖：

```powershell
cd app
npm install
```

启动本地高级版：

```powershell
cd ..
.\start.bat
```

浏览器打开：

```text
http://127.0.0.1:6137
```

`start.bat` 会构建前端并启动本地导出服务。本地模式适合路线编辑、景点资料整理、Markdown/PDF/MP4 导出。

只预览网站前端：

```powershell
cd app
npm run dev
```

## 网站部署

推荐部署方式：

| 组件 | 用途 |
| --- | --- |
| Caddy | 静态网站、HTTPS、Cloud-IAM 反向代理 |
| Cloud-IAM | 用户注册、用户名密码登录、忘记密码、修改密码 |
| Supabase | 数据库、存储、登录态、权限隔离 |
| 渲染 Worker | 可选，后台生成路线图、Markdown、PDF、MP4 |

服务器部署、域名解析、Cloud-IAM、Supabase、Caddy 和 Worker 的完整配置见：[docs/deployment_manual.md](docs/deployment_manual.md)。

## 站点管理员

admin 用户负责维护全站高德地图配置。满足以下任一条件的登录用户会被识别为 admin：

```text
email = admin@map.bestapi.best
preferred_username = admin
username = admin
name = admin
```

admin 可以保存高德 Web JS API Key 和 `securityJsCode`。普通用户只能读取这份配置加载地图，不能修改配置，也不能看到 admin 的测试路线。

## 路线使用

在地图页可以完成：

- 新建路线
- 添加每天的起点、途经点、终点或住宿点
- 搜索地点并刷新路线
- 编辑景点介绍和图片
- 导出路线资料

网站模式下，路线按登录用户隔离保存。景点介绍和已发布路线属于共享资料，登录用户可以共同补充和维护。

## 本地导出

本地模式点击导出后，文件会写入：

```text
data/routes/<路线名>/
```

常见产物：

```text
<路线名>.route.json
<路线名>.mp4-data.json
<路线名>.travel.md
<路线名>.travel.pdf
<路线名>.mp4
```

`data/routes/` 和 `data/config/local.env` 属于本地个人数据，不提交到 Git。网站模式的路线、公共路线、景点介绍和公共资产保存在 Supabase。

## 景点资料

景点资料保存在 Supabase 中，由登录用户共同维护；每次编辑都会记录可查看的 diff。

## 目录说明

| 路径 | 说明 |
| --- | --- |
| `start.bat` | 本地启动入口 |
| `app/web/` | 网站前端、登录页、地图页、个人页 |
| `app/server/` | 本地服务、归档和导出逻辑 |
| `app/worker/` | 网站端后台渲染 Worker |
| `app/video/` | Remotion 视频工程 |
| `app/cloud/` | Supabase 迁移和云端配置说明 |
| `data/routes/` | 本地开发模式的临时导出文件，不提交 |
| `data/config/` | 本地私有配置 |
| `docs/` | 项目文档 |

## 安全约定

- 不要提交 Supabase Service Role Key。
- 不要提交 `.env.production`、`worker.env`、`data/config/local.env`。
- 不要提交个人路线和导出文件。
- Cloud-IAM 默认管理员密码上线前必须修改。
- 高德地图 Key 在网站中由 admin 维护。
