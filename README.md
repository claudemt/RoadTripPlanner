<p align="center">
  <img src="https://img.shields.io/badge/地图-高德-orange" alt="Amap">
  <img src="https://img.shields.io/badge/导出-PDF%20%7C%20PNG%20%7C%20MP4-blue" alt="Export">
  <img src="https://img.shields.io/badge/多用户-Supabase-green" alt="Supabase">
</p>

<h1 align="center">🗺️ RoadTripPlanner</h1>
<p align="center"><b>把一条自驾路线，炼成一份能交付、能展示、能复用的路书产品。</b></p>

<p align="center">
  <a href="#-功能">功能</a> ·
  <a href="#-quick-start">快速上手</a> ·
  <a href="#-部署">部署</a> ·
  <a href="#-导出产物">导出产物</a>
</p>

---

## 💡 为什么需要它？

做一条真正的自驾路线，难点从来不只是"怎么走"：每天住哪里、停哪里、哪里值得讲，以及如何把这一切变成别人能看懂、能执行、能分享的东西。

**RoadTripPlanner 把这件事一口气串起来**——从路线灵感、高德地图轨迹，到景点讲解稿，再到可交付的 PDF、PNG 和 MP4。

---

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 🛣️ **多天路线规划** | 每天安排起点、途经点、住宿点，组织行程节奏 |
| 🧭 **高德地图轨迹** | 搜索真实 POI，自动计算轨迹、距离和耗时 |
| 🏷️ **可拖拽地点标签** | 标签位置可调，并同步到导出图与视频 |
| 👤 **私有路线与讲解稿** | 按用户隔离；也可发布公共模板，别人导入成独立副本 |
| 🧠 **说明优先级** | 点位优先用私有讲解稿，没有时回退公共景点资料 |
| 📦 **一键产品导出** | JSON、总览 PNG、Markdown、PDF、MP4、ZIP |

---

## 🚀 快速上手

```powershell
cd app
npm install
cd ..
.\start.bat
```

打开 `http://127.0.0.1:6137`，即可开始规划路线并导出。

---

## 🚢 部署

RoadTripPlanner 可以部署成多人网站：Caddy 负责 HTTPS 与登录认证，Supabase 保存多用户路线、景点与公共资产，systemd 常驻运行。

完整上线步骤见 [部署手册](docs/deployment_manual.md)。

---

## 📦 导出产物

导出文件写入 `data/routes/<路线名>/`：

```text
<路线名>.route.json      # 路线数据
<路线名>.route-map.png   # 路线总览图
<路线名>.travel.md       # Markdown 路书
<路线名>.travel.pdf      # PDF 路书
<路线名>.mp4             # 路线视频
<路线名>.product.zip     # 全部产物打包
```

---

## 🤝 贡献

欢迎 Issue 与 PR：新导出格式、更漂亮的路书模板、更多地图数据源、部署优化。

---

<p align="center">
  <b>如果这个项目对你有帮助，欢迎 ⭐ Star ⭐ 让更多人看到</b>
</p>