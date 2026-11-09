<p align="center">
  <img src="https://img.shields.io/badge/地图-高德-orange" alt="Amap">
  <img src="https://img.shields.io/badge/导出-PDF%20%7C%20PNG%20%7C%20MP4-blue" alt="Export">
  <img src="https://img.shields.io/badge/多用户-Supabase-green" alt="Supabase">
</p>

<h1 align="center">🗺️ RoadTripPlanner</h1>
<p align="center"><b>可以直接导出宣发视频的本地路书。</b></p>

<p align="center">
  <a href="#-功能">功能</a> ·
  <a href="#-quick-start">快速上手</a> ·
  <a href="#-三种用法">三种用法</a> ·
  <a href="#-脚本化调用">脚本化调用</a> ·
  <a href="#-导出产物">导出产物</a>
</p>

## 💡 为什么需要它？

自驾、骑行或步行的多日路线，往往散落在地图收藏、行程表、景点笔记和照片里。规划路线之后，还要重新排版路书、绘制总览图、制作介绍视频。

RoadTripPlanner 将点位、路段、景点介绍和沿途信息放在同一份可编辑路书中，并生成可分享的地图、PDF 和宣发视频。

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 🧭 **多来源路线规划** | 高德查不到路线时自动尝试 OpenStreetMap / OSRM；备选不足时补充不同走法，还可根据公路名提取轨迹或手绘路线 |
| 🚗 **多种交通方式** | 多日行程逐段选择驾车、骑行或步行，比较路线并保留自己的选择 |
| ⛰️ **地形与沿途信息** | 底图叠加山影，点位显示海拔和天气，并同步到地图导出与视频 |
| 📍 **可编辑的地图** | 拖动地点标签、调整途经点和路线，让总览图与视频中的地图保持一致 |
| 🖼️ **景点与路线介绍** | 为路线和景点加入文字、照片；可使用个人资料或公共景点资料 |
| 📷 **相机原图直传** | HEIC 自动转为 JPEG；超过 2560px 或 8MB 的照片自动压缩，浮窗显示处理与上传进度 |
| 🎬 **直接生成宣发视频** | 连同路线总览 PNG、Markdown、PDF 和 ZIP 一起导出，视频展示地图轨迹与景点介绍 |

## 🚀 快速上手

需要 Node.js 20.19+ 或 22.12+。到[高德开放平台](https://lbs.amap.com/api/javascript-api-v2/prerequisites)申请 Web 端 Key 与安全密钥。Windows PowerShell 启动：

```powershell
Copy-Item config/local.env.example config/local.env
npm --prefix app ci
# 将 Key 和安全密钥填入 config/local.env 的 AMAP_KEY、AMAP_SECURITY_JS_CODE
.\start.bat
```

打开 `http://127.0.0.1:6137`。导出 PNG/PDF/MP4 需要 Chrome、Edge 或 Chromium，MP4 还需要 FFmpeg。除了高德 Key，不需要再配置任何东西：路线、景点图片、音乐和导出产物都写在 `output/`，本地密钥和数据不会提交到 Git。

路线备选使用 [OpenStreetMap](https://www.openstreetmap.org/)、[OSRM](https://project-osrm.org/) 和 [Overpass](https://overpass-api.de/)；天气与海拔来自 [Open-Meteo](https://open-meteo.com/)，山影来自 [Esri World Hillshade](https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer)。这些服务已默认接入，无需另申请密钥。

## 🗂️ 三种用法

| 用法 | 需要配置 | 数据位置 |
|------|----------|----------|
| **本机自用**（绝大多数） | 只填高德 Key | 项目里的 `output/` |
| **访问已部署的站点** | 什么都不用配 | 站长的服务器 |
| **自己部署成网站** | Supabase + `ROADTRIP_STORAGE=cloud` | Supabase |

本机自用没有账号、邮箱和数据库，打开页面就是本机用户。备份直接复制 `output/`：

```text
output/
  routes/<路线名>/     # route.json、metadata.json 和导出的 PNG / PDF / MD / MP4
  scene-assets/        # 景点照片
  music/               # 上传的音乐
```

自己部署成网站时，用 Nginx / Caddy / OAuth2 Proxy 等认证代理注入 `X-Auth-Request-Email`，并把代理地址加入 `ROADTRIP_TRUSTED_PROXY_IPS`。没有认证代理的单人站点改用 `ROADTRIP_SINGLE_USER=true`，所有访问者共用本机的 `output/`。完整变量见 `config/local.env.example`。

## 🤖 脚本化调用

不想把时间浪费在重复点击上？直接用 CLI 或 `/api/v1` 批量创建路线、修改点位、维护景点、启动后台导出并下载完整产品：

```powershell
cd app
npm run cli -- route create --file .\route.json
npm run cli -- route export <route-id> --wait
npm run cli -- route download <route-id> --out .\product.zip
```

完整命令、HTTP 接口、账号身份、批量调用和视频计时规则见 [脚本化接口手册](docs/cli_api.md)。

## 📦 导出产物

导出文件保存在本地模式的 `output/routes/<路线名>/`（云端模式则保存在 Supabase 对象存储），也可下载打包 ZIP：

```text
<路线名>.route.json      # 路线数据
<路线名>.route-map.png   # 路线总览图
<路线名>.travel.md       # Markdown 路书
<路线名>.travel.pdf      # PDF 路书
<路线名>.mp4             # 路线视频
<路线名>.product.zip     # 下载时生成的全部产物包
```

## 🤝 贡献

欢迎 Issue 与 PR：新导出格式、更漂亮的路书模板、更多地图数据源、部署优化。

<p align="center">
  <b>如果这个项目对你有帮助，欢迎 ⭐ Star ⭐ 让更多人看到</b>
</p>
