# RoadTripPlanner

一个本地运行的自驾路线规划工具。它使用高德 Web JS API 做交互式地图、地点搜索和驾车路线计算；路线编辑完成后，可以导出路线 JSON、旅行手册 Markdown/PDF 和 Remotion MP4 视频。

## 快速开始

1. 安装依赖：

```powershell
cd app
npm install
```

2. 启动本地服务：

```powershell
.\start.bat
```

也可以直接双击根目录的 `start.bat`。

3. 浏览器打开：

```text
http://127.0.0.1:6137
```

直接打开 `app/web/index.html` 不能完整使用，因为密钥配置、路线扫描和导出都需要本地服务。

## 配置高德密钥

第一次打开界面时会提示填写：

- Web JS API Key
- securityJsCode

保存后会写入 `data/config/local.env`。这个文件已被 `.gitignore` 排除，不会提交到 GitHub。

高德控制台里请把 `127.0.0.1` 和 `localhost` 加入 Web 端白名单。

## 创建路线

- 点顶部「新建」创建总体路线。
- 第二行下拉框用于切换路线，也会自动显示 `data/routes/` 下已有路线。
- 点「编辑」可以改路线名称、添加天数、删除路线。
- 每一天里可以设置起点、途径点、终点/住宿点。
- 点「刷新」计算当前路线并显示在地图上。

## 导出产品

点顶部「导出」，会写入：

```text
data/routes/<路线名>/
```

通常包含：

- `<路线名>.route.json`
- `<路线名>.mp4-data.json`
- `<路线名>.travel.md`
- `<路线名>.travel.pdf`
- `<路线名>.mp4`

未点「导出」前，编辑内容只保存在浏览器本地。

## 景点介绍

在某个点位上点「改」时，可以同时编辑景点介绍：

- 输入介绍文字
- 从本地选择图片
- 确认后写入 `data/scenes/<景点名>/`
- 图片会按统一格式命名，并在该景点 JS 数据中引用

`data/scenes/` 可以提交到 GitHub，用来沉淀和共享景点介绍。`data/routes/` 和 `data/config/local.env` 是个人数据，不提交。

## 项目结构

| 路径 | 说明 |
|------|------|
| `start.bat` | 唯一启动入口 |
| `app/web/` | 浏览器端页面、样式与功能模块 |
| `app/server/` | 本地 Node 服务、归档和导出逻辑 |
| `app/video/` | Remotion/TypeScript 视频工程 |
| `app/package.json` | 统一 npm 工作区入口 |
| `data/config/` | 本机地图密钥配置 |
| `data/routes/` | 本地路线、PDF 和视频导出 |
| `data/scenes/` | 可共享的景点介绍和图片 |
| `docs/` | 项目文档 |

浏览器仍通过 `/scene/...` 和 `/route/...` 访问资源，这是服务端提供的稳定公共 URL；对应磁盘目录分别是 `data/scenes/` 和 `data/routes/`。
