# 中国移动云手机 · 多用户长期保活与 Web 实时显示控制系统

纯原生 Node.js 20（零第三方编译依赖）打造的中国移动云手机多租户管理、长期信令连接保活与 WebRTC 实时显示触控控制平台。

## 核心能力

1. **官方手机验证码登录**：完整对接官方 H5 v6.6.8 协议栈（RSA-PKCS1 参数加密、交互式拼图滑块验证、短信验证码登录、`x-workkey` AES-128-GCM 响应自动解密），同时兼容密码登录与 Token 导入。
2. **7×24 小时原生长期连接保活**：
   - **云版底座（`platformType=1`）**：纯原生 Engine.IO v3 / Socket.IO WebSocket 信令网关长连接 + 自动心跳与实例活跃脉冲守护；
   - **T版底座（`platformType=2`）**：纯原生命令通道 WebSocket 长连接 + 15 秒双通道 `CMD_ACTION_HEART (100022)` 心跳守护；
   - **自动唤醒与断线重连**：休眠或回收态自动唤醒，网络波动指数退避重连，官方 Token 定时巡检与无感续期。
3. **多用户严格隔离**：
   - 首个注册用户自动成为管理员，支持多用户独立注册登录及管理员用户/配额管理；
   - 每个用户的移动账号、云手机列表、保活任务、Web 控制流及实时日志严格按 `ownerId` 隔离，敏感 Token 采用 `AES-256-GCM` 加密落盘。
4. **Web 实时画面显示与触控控制（防互踢无缝交接）**：
   - 内置云版 `CloudPhoneClient` 与 T版原生 WebRTC 播放器，支持高清视频流实时显示、鼠标/触屏滑动点击、三大金刚键（多任务 / 主页 / 返回）、文字同步、画质切换与 RTT 延迟显示；
   - 打开 Web 控制时自动通过租约机制暂停后台占线保活，退出 Web 控制后自动无缝恢复后台长期保活。

## 启动方式

```bash
# 直接运行 (Node.js >= 20)
PORT=8680 node src/server.js

# 或使用 Docker Compose
docker compose up -d --build
```

## Docker 部署教程

### 方式一：拉取现成镜像（推荐）

镜像已发布到 Docker Hub：`lusean23/cmcc-phone:latest`（每次源码更新由 GitHub Actions 自动重新构建推送）。

```bash
docker run -d \
  --name cmcc-cloudphone-manager \
  --restart unless-stopped \
  -p 8680:8680 \
  -e TZ=Asia/Shanghai \
  -v cmcc-data:/app/data \
  lusean23/cmcc-phone:latest
```

启动后打开 `http://localhost:8680`，注册的第一个账号即为管理员。

### 方式二：Docker Compose（使用现成镜像）

```yaml
services:
  cmcc-cloudphone-manager:
    image: lusean23/cmcc-phone:latest
    container_name: cmcc-cloudphone-manager
    restart: unless-stopped
    ports:
      - "8680:8680"
    environment:
      - TZ=Asia/Shanghai
      - PORT=8680
      - DATA_DIR=/app/data
    volumes:
      - ./data:/app/data
```

```bash
docker compose up -d
```

### 数据持久化

- 所有账号、设备与令牌数据都存放在容器的 `/app/data` 目录（`DATA_DIR` 环境变量可改），务必挂载到宿主机目录或命名卷（如上例），否则重建容器会丢失数据。
- 升级镜像：`docker pull lusean23/cmcc-phone:latest` 后重建容器即可，数据卷不受影响。
