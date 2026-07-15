# 云端发布说明

## 1. 创建 Supabase

1. 创建一个 Supabase 项目。
2. 打开 SQL Editor。
3. 执行 `supabase/migrations/001_initial_schema.sql`。
4. 在 Authentication 中启用 Email provider，并使用后台创建用户；前端会把用户名映射为内部邮箱账号。
5. 忘记密码时使用 Supabase 邮件找回，把正式域名加入 Supabase 允许的站点 URL。
6. 执行 `supabase/migrations/002_cloud_exports.sql` 和 `supabase/migrations/003_app_settings.sql`。

原来的 `data/scenes/` 会继续作为网站内置的景点资料。登录用户第一次
修改某个景点后，新版本会进入 Supabase，并优先于本地内置版本显示。

## 2. 配置 EdgeOne Pages

在 EdgeOne 中导入 Git 仓库，并把项目根目录设置为 `app`。

项目中的 `edgeone.json` 已经配置好 Node 版本、安装命令、构建命令、
输出目录和基础安全响应头。等价参数如下：

| 设置 | 值 |
|---|---|
| 项目根目录 | `app` |
| 安装命令 | `npm ci` |
| 构建命令 | `npm run build` |
| 输出目录 | `dist` |

然后按照 `app/.env.example` 添加环境变量。

Supabase Publishable Key 可以放在浏览器端。用户数据权限由迁移文件里的
RLS 规则控制，不要把 Supabase Service Role Key 填入 EdgeOne。

## 3. 配置高德地图

创建高德 Web JS API Key，并把 EdgeOne 预览域名和正式域名加入高德域名
白名单。生产站点由 admin 登录网站后在配置页填写 Web JS API Key 和
securityJsCode，保存到 Supabase `app_settings` 后所有用户刷新即可加载地图。

`VITE_AMAP_KEY` 和 `VITE_AMAP_SECURITY_JS_CODE` 仍可作为 EdgeOne 构建变量兜底，
但不再是主要配置入口。

## 4. 本地运行

- `npm run dev`：预览静态网站。
- 根目录 `start.bat`：构建网站并启动本地高级导出服务。
- 第一版网站只下载路线 JSON；PDF 和 MP4 继续由本地版生成。
