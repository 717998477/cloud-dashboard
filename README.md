# 云电脑统一面板（私人仓库镜像版）

一个容器同时跑两套保活面板，源码已固化在本仓库，**不依赖上游仓库是否还存在**。

| 组件 | 目录 | 端口 | 说明 |
|---|---|---|---|
| 天翼云 / 移动云电脑面板 | `ctyun-dashboard/` | **8566** | 原样镜像自 [muyicn/ctyun-dashboard](https://github.com/muyicn/ctyun-dashboard)，未改一行代码 |
| 中国移动云手机面板 | `cmcc-phone/` | **8577** | 原样镜像自 [maoaceo/cmcc-phone](https://github.com/maoaceo/cmcc-phone)，未改一行代码 |
| 统一入口页 | `deploy/` | **8555** | 跳转 + 聚合健康检查 |

## 构建与启动

```bash
git clone <你的仓库地址> cloud-dashboard
cd cloud-dashboard

docker compose up -d --build
docker compose ps
docker compose logs -f --tail=50
```

首次构建约 3～5 分钟（耗时主要在安装 python 依赖）。启动后：

- `http://NAS-IP:8555` 统一入口页
- `http://NAS-IP:8566` 天翼云面板，初始账号 `admin` / `admin123`（**登录后立刻改密**）
- `http://NAS-IP:8577` 移动云手机面板，第一个注册的账号即管理员

## 数据

- 两个面板数据都在宿主机 `./data`：`data/ctyun`、`data/cmcc`
- 备份这个目录就是全量备份（凭据以 AES-256-GCM 加密落盘）
- 删容器不删数据；`docker compose down -v` 才会删

## 改端口

只改两处：`docker-compose.yml` 的端口映射，以及同文件里 `CTYUN_PORT` / `CMCC_PORT` / `PORTAL_PORT` 环境变量。入口页会从 `/health` 读取实际端口自动更新跳转，不用改前端。

## 更新上游

```bash
# 在能访问上游的时候，把新版本拉进本仓库
git clone --depth 1 https://github.com/muyicn/ctyun-dashboard.git /tmp/ctyun
rsync -a --delete --exclude .git /tmp/ctyun/ ctyun-dashboard/
git add -A && git commit -m "update ctyun-dashboard" && git push
```

`SOURCES.txt` 记录了当前两个目录对应的上游 commit。

## 说明

- `ctyun-dashboard/node_modules` 已被提交（仅 `ws` 一个依赖），目的是让构建不依赖 npm 源；介意仓库体积可以删掉，构建时会自动 `npm install` 补回。
- 两个面板的代码未做任何修改，升级时整目录替换即可。
- 上游两个项目根目录均未附 LICENSE，本仓库仅供自用，请勿公开分发。
