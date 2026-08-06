# RoadTripPlanner 脚本化接口

RoadTripPlanner 的路线、景点和导出功能可以通过 `/api/v1` 或随项目提供的 CLI 调用。接口使用 Caddy 传入的邮箱作为账号身份，因此同一台服务器上的不同用户会自动进入各自的路线和景点空间。

## 快速开始

在服务器本机：

```powershell
cd E:\OneDrive\Desktop\RoadTripPlanner\app
$env:ROADTRIP_BASE_URL = "https://map.example.com"
$env:ROADTRIP_EMAIL = "me@example.com"
npm run cli -- account
```

在本地通过 SSH 隧道访问 jerry：

```powershell
ssh -N -L 6137:127.0.0.1:6137 me@jerry
cd E:\OneDrive\Desktop\RoadTripPlanner\app
$env:ROADTRIP_BASE_URL = "http://127.0.0.1:6137"
$env:ROADTRIP_EMAIL = "me@example.com"
npm run cli -- route list
```

也可以直接运行：

```powershell
node scripts/roadtrip-cli.js route list --base https://map.example.com --email me@example.com
```

CLI 默认使用 `http://127.0.0.1:6137`，支持：

```text
ROADTRIP_BASE_URL   API 根地址
ROADTRIP_EMAIL      当前账号邮箱
--timeout           请求超时毫秒数，默认 120000
```

## 路线 JSON

最小路线文件 `route.json`：

```json
{
  "id": "beijing-university-loop",
  "name": "北京高校环线",
  "days": [
    {
      "title": "第 1 天",
      "from": {
        "name": "北京大学",
        "lng": 116.3109,
        "lat": 39.9928,
        "transportMode": "ride",
        "useScenic": false,
        "labelOffset": { "x": 0, "y": 0 }
      },
      "waypoints": [
        {
          "name": "中国人民大学",
          "lng": 116.3212,
          "lat": 39.9669,
          "transportMode": "ride"
        }
      ],
      "to": {
        "name": "清华大学",
        "lng": 116.3264,
        "lat": 40.0033,
        "transportMode": "ride"
      }
    }
  ]
}
```

点位名称应使用高德地图能够匹配的 POI 名称。`labelOffset` 是路线内的文字标记位置记忆，刷新页面或重新登录后仍会保留；它只属于当前路线，不会跨路线复用。

## CLI 命令

查看账号和接口能力：

```powershell
npm run cli -- account
npm run cli -- api
```

创建、查看、替换路线：

```powershell
npm run cli -- route create --file route.json
npm run cli -- route list
npm run cli -- route get beijing-university-loop
npm run cli -- route replace beijing-university-loop --file route.json
```

编辑某一天的点位。`--day` 从 1 开始，位置可以是 `from`、`to` 或 `waypoint:1`：

```powershell
npm run cli -- route point-set beijing-university-loop `
  --day 1 --position waypoint:1 `
  --name "中国人民大学" --lng 116.3212 --lat 39.9669 `
  --mode ride --label-x 0.08 --label-y -0.04
```

关闭某个点位的景点说明：

```powershell
npm run cli -- route point-set beijing-university-loop `
  --day 1 --position waypoint:1 --use-scenic false
```

后台导出完整产品：

```powershell
npm run cli -- route export beijing-university-loop --wait
```

服务器会生成并保存 JSON、路线总览 PNG、Markdown、PDF、MP4 和 ZIP。也可以只提交任务，不等待：

```powershell
npm run cli -- route export beijing-university-loop
npm run cli -- route status <taskId>
npm run cli -- route download beijing-university-loop --out .\beijing-university-loop.product.zip
```

## 景点库

公共景点默认展示最新版本，编辑会写入历史版本。公共景点只能通过公共编辑接口修改；个人景点可以新建、修改、从公共景点导入，但不会反向发布到公共库。

```powershell
npm run cli -- spot public-list
npm run cli -- spot public-get --name "北京大学"
npm run cli -- spot public-revisions --name "北京大学"
npm run cli -- spot public-save --file public-spot.json

npm run cli -- spot private-list
npm run cli -- spot private-save --file private-spot.json
npm run cli -- spot private-import --name "北京大学"
npm run cli -- spot private-delete --id <privateSpotId>
```

景点 JSON 可包含：

```json
{
  "name": "北京大学",
  "title": "北京大学",
  "description": "这里是精华，会停留 2 小时。",
  "images": ["C:\\images\\pku.jpg"],
  "changeNote": "补充开放时间"
}
```

CLI 会把本地图片自动转换为上传数据；图片 URL 也可以直接放入 `images`。

路线中的景点说明优先级是：个人库同名景点 > 公共库同名景点 > 无说明。点位设置 `useScenic: false` 时，该点不会采用任何景点说明。

## HTTP 接口

所有请求都应带上由 Caddy 传递的账号邮箱。脚本直连时可使用：

```http
X-Auth-Request-Email: me@example.com
```

主要接口：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/v1/account` | 当前账号和能力 |
| `GET` | `/api/v1/routes` | 我的路线列表 |
| `POST` | `/api/v1/routes` | 新建或保存路线 |
| `GET` | `/api/v1/routes/:id` | 读取路线 |
| `PUT` | `/api/v1/routes/:id` | 完整替换路线 |
| `PATCH` | `/api/v1/routes/:id/points` | 修改单个点位 |
| `DELETE` | `/api/v1/routes/:id` | 删除路线 |
| `POST` | `/api/v1/routes/:id/export` | 后台导出 |
| `GET` | `/api/v1/export-progress` | 当前账号最近任务 |
| `GET` | `/api/v1/exports/:taskId` | 查询指定任务 |
| `POST` | `/api/v1/exports/:taskId/cancel` | 终止当前可取消任务 |
| `GET` | `/api/v1/routes/:id/product.zip` | 下载路线 ZIP |
| `GET` | `/api/v1/published-routes` | 公共路线列表 |
| `POST` | `/api/v1/published-routes` | 发布公共路线 |
| `POST` | `/api/v1/published-routes/:id/import` | 导入公共路线为个人副本 |
| `GET` | `/api/v1/spots/public` | 公共景点列表或按名称查询 |
| `PUT` | `/api/v1/spots/public` | 编辑公共景点并生成新版本 |
| `GET` | `/api/v1/spots/public/revisions` | 查看公共景点历史 |
| `GET` | `/api/v1/spots/private` | 我的景点列表 |
| `PUT` | `/api/v1/spots/private` | 新建或修改个人景点 |
| `POST` | `/api/v1/spots/private/import` | 从公共景点导入 |

路线创建和点位修改接口会立即写入当前账号的 Supabase 空间。导出接口返回 `202` 和 `taskId`，视频、PNG、PDF 等重任务在服务器后台执行，期间可以继续编辑路线。

## 视频计时规则

视频不按实际路程长短分配动画时间，而是按相邻点位固定计时：

```text
每个相邻点位之间：1.5 秒
每天抵达终点后：停留 3 秒
```

因此，一天有 3 个途经点时，起点到终点共有 4 段，路线动画时长为 `4 × 1.5 + 3 = 9 秒`。地图缩放、路程远近和高德轨迹点数量不会改变这个规则。

## 批量生成

PowerShell 示例：

```powershell
$routes = Get-ChildItem .\routes -Filter *.json
foreach ($file in $routes) {
  $result = node .\scripts\roadtrip-cli.js route create --file $file.FullName
  $result
}
```

需要评估多条 AI 方案时，可以先批量 `route create`，再根据返回的路线 ID 调用 `route export --wait`，最后用 `route download` 收集产品 ZIP。

## 版本约定

`/api/v1` 是路线业务的正式自动化接口。旧的未版本化路线、景点、公共路线和导出路径已经从发布版本中移除，脚本和网页端都不应再调用它们。
