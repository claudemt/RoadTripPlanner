# RoadTripPlanner v2.1 Caddy 部署手册

身份认证、HTTPS 和公网入口由 Caddy 负责；RoadTripPlanner 通过 systemd 运行在 `0.0.0.0:6137`，该端口必须只允许本机 Caddy 或受控内网访问。

## 1. 构建

```bash
cd /opt/RoadTripPlanner/app
npm ci
npm run release:check
```

`release:check` 会依次检查服务端、网页构建、地图增强逻辑和视频类型。全部通过后再重启线上服务。

## 2. 启动应用

```bash
sudo systemctl enable --now map
```

`/etc/roadplan/map.env` 保存运行时密钥和参数，程序目录不保存生产密钥。

地图增强功能的缓存统一写入 `ROADTRIP_DATA_ROOT/cache`。默认天气与海拔使用 Open-Meteo，山影使用 Esri World Hillshade；可在环境文件中覆盖：

```text
HILLSHADE_ENABLED=true
HILLSHADE_SOURCE_URL=https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}
HILLSHADE_CACHE_VERSION=v1
HILLSHADE_MIN_ZOOM=5
HILLSHADE_MAX_ZOOM=12
POINT_INFO_WEATHER_TTL_MINUTES=30
```

服务器需要能访问 Open-Meteo 和配置的山影源；临时访问失败时应用会使用已有缓存或透明山影瓦片，不影响路线编辑。

## 3. 配置 Caddy

认证服务应在认证成功后向 Caddy 返回一个包含完整邮箱的响应头。示例：

```caddyfile
map.example.com {
    forward_auth 127.0.0.1:9091 {
        uri /verify
        copy_headers X-Auth-Request-Email
    }

    reverse_proxy 127.0.0.1:6137
}
```

应用环境变量必须与该请求头一致：

```text
ROADTRIP_USER_EMAIL_HEADER=X-Auth-Request-Email
```

Caddy 必须覆盖或清理客户端自行提交的同名身份头，身份头只能来自受信任的认证流程。

## 4. 测试

```bash
curl -H 'X-Auth-Request-Email: user@example.com' \
  http://127.0.0.1:6137/api/session
```

浏览器访问 Caddy 域名后，页面左上角应显示相同邮箱。

## 5. 必须反代的路径

建议直接反代整个站点。至少必须包含：

```text
/
/api/*
/route/*
```

## 6. 数据隔离

- 路线草稿：浏览器中按邮箱隔离。
- 路线导出：`data/routes/users/<email>/`（仅在启用本地归档时使用）。
- 景点资料：公共内容和用户内容保存在 Supabase。
- 高德地图配置：全站共享。

## 7. 升级

升级前备份：

```bash
tar -czf roadtrip-data-backup.tgz /opt/RoadTripPlanner/data
```

然后执行：

```bash
cd /opt/RoadTripPlanner
git pull --ff-only
cd app
npm ci
npm run release:check
sudo systemctl restart map
curl -fsS http://127.0.0.1:6137/api/health
sudo systemctl --no-pager --full status map
```

返回 `"ok":true` 且 systemd 状态为 `active (running)` 即完成升级。v2.1 不需要数据库迁移；首次访问山影、天气和海拔服务时会自动创建缓存目录。

### v2.1 接口整理

- 导出状态与取消统一使用 `/api/v1/exports/:taskId` 和 `/api/v1/exports/:taskId/cancel`。
- 已删除旧的 `/api/v1/export-progress`、`/api/v1/export-cancel`。
- 路线写入与导出请求统一使用 `routeData` 字段。
