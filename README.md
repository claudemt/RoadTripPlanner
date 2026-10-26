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

打开 `http://127.0.0.1:6137`。导出 PNG/PDF/MP4 需要 Chrome、Edge 或 Chromium，MP4 还需要 FFmpeg。数据保存在 `data/`，本地密钥和数据不会提交到 Git。

路线备选使用 [OpenStreetMap](https://www.openstreetmap.org/)、[OSRM](https://project-osrm.org/) 和 [Overpass](https://overpass-api.de/)；天气与海拔来自 [Open-Meteo](https://open-meteo.com/)，山影来自 [Esri World Hillshade](https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer)。这些服务已默认接入，无需另申请密钥。

## 🌐 上线与账号

多人网站需要认证代理（Nginx、Caddy、OAuth2 Proxy 等）在请求中注入 `X-Auth-Request-Email`，并配置 Supabase 保存社区数据。服务端只信任来自 `ROADTRIP_TRUSTED_PROXY_IPS` 的身份头；也可用 `ROADTRIP_PROXY_SECRET` 再加一道共享密钥。完整变量见 `config/local.env.example`。

单人服务器若没有认证代理，可显式设置 `ROADTRIP_REQUIRE_USER_EMAIL=false`、`ROADTRIP_FALLBACK_USER_EMAIL=你的邮箱`、`ROADTRIP_FALLBACK_LOCAL_ONLY=false`：所有访问共用该账号，不要再把这个端口直接暴露到公网。

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

导出文件保存在 `data/routes/users/<用户邮箱>/<路线名>/`，也可下载打包 ZIP：

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
