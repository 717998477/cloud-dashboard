# 云电脑统一面板（天翼云 + 移动云手机，单容器）

一个容器同时跑两套保活面板，源码已固化在本仓库，不依赖上游仓库是否还存在。

| 组件 | 目录 | 端口 | 说明 |
|---|---|---|---|
| 天翼云 / 移动云电脑面板 | `ctyun-dashboard/` | **8566** | 镜像自 [muyicn/ctyun-dashboard](https://github.com/muyicn/ctyun-dashboard)，未改代码 |
| 中国移动云手机面板 | `cmcc-phone/` | **8577** | 镜像自 [maoaceo/cmcc-phone](https://github.com/maoaceo/cmcc-phone)，未改代码 |
| 统一入口页 | `deploy/` | **8555** | 跳转 + 聚合健康检查 |

## 方式一：直接用现成镜像（飞牛「Docker → Compose → 创建项目」粘贴即用）

每次推送代码，GitHub Actions 会自动构建镜像并推到 GHCR：`ghcr.io/717998477/cloud-dashboard:latest`。

在飞牛「创建项目」里把下面的内容整体粘进 compose 编辑框，路径随便选一个空目录（数据会落在该目录的 `data/` 下），勾选“创建项目后立即启动”即可：

```yaml
services:
  cloud-dashboard:
    image: ghcr.io/717998477/cloud-dashboard:latest
    container_name: cloud-dashboard
    restart: unless-stopped
    ports:
      - "8555:8555"
      - "8566:8566"
      - "8577:8577"
    environment:
      - TZ=Asia/Shanghai
      - DATA_ROOT=/data
    volumes:
      - ./data:/data
```

> 镜像是**私有**的。首次拉取前要在飞牛「Docker → 镜像仓库」里加一个 `ghcr.io` 账号：用户名 `717998477`，密码填一个有 `read:packages` 权限的 token（classic token 勾 `repo` 即可）。配一次就行，之后每次拉取都不再问。
>
> 不想配凭据的话，可以在 GitHub 上把该 Package 的可见性改成 Public——但上游两个项目都没有 LICENSE，公开等于再分发，风险自己权衡。

## 方式二：本地构建（不依赖镜像仓库）

```bash
git clone https://github.com/717998477/cloud-dashboard.git
cd cloud-dashboard
docker compose -f docker-compose.build.yml up -d --build
```

首次构建约 3～5 分钟。构建只用到 `node:22-bookworm-slim` 基础镜像、Debian 源和 PyPI，不访问 GitHub。

## 访问

- `http://NAS-IP:8555` 统一入口页
- `http://NAS-IP:8566` 天翼云面板，初始账号 `admin` / `admin123`（**登录后立刻改密**）
- `http://NAS-IP:8577` 移动云手机面板，第一个注册的账号即管理员

## 数据

- 数据都在宿主机 `./data`：`data/ctyun`、`data/cmcc`，备份这个目录就是全量备份
- 删容器不删数据；`docker compose down -v` 才会删

## 改端口

只改 `docker-compose.yml` 的端口映射与环境变量两处，入口页会从 `/health` 读取实际端口自动更新跳转。

## 更新上游

```bash
git clone --depth 1 https://github.com/muyicn/ctyun-dashboard.git /tmp/ctyun
rsync -a --delete --exclude .git /tmp/ctyun/ ctyun-dashboard/
git add -A && git commit -m "update ctyun-dashboard" && git push
```

推送后 Actions 自动重建镜像，`SOURCES.txt` 记录当前对应的上游 commit。

## 说明

- `ctyun-dashboard/node_modules` 已提交（仅 `ws` 一个依赖），构建不依赖 npm 源
- 两个面板代码零改动，升级时整目录替换
- 默认只构建 `linux/amd64`；ARM 机型把 `.github/workflows/build-image.yml` 里的 `platforms` 改成 `linux/amd64,linux/arm64`
- 上游项目无 LICENSE，本仓库仅供自用，请勿公开分发
