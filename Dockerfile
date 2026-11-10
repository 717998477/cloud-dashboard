# 单容器：天翼云面板 + 移动云手机面板
#
# 仓库内已自带两个项目的源码（ctyun-dashboard/、cmcc-phone/），
# 构建过程不访问 GitHub，也不依赖上游仓库是否还在。
# 依赖：node:22-bookworm-slim 基础镜像、Debian 源（python3/tini）、PyPI（requests/pycryptodome）。

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${NODE_IMAGE}

ARG PIP_INDEX
ARG NPM_REGISTRY

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    LANG=C.UTF-8 \
    PORTAL_PORT=8555 \
    CTYUN_PORT=8566 \
    CMCC_PORT=8577 \
    DATA_ROOT=/data \
    ECLOUD_PYTHON=/usr/bin/python3

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip tini \
 && pip3 install --no-cache-dir --break-system-packages -i "$PIP_INDEX" requests pycryptodome \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY ctyun-dashboard /opt/ctyun
COPY cmcc-phone      /opt/cmcc

# 仓库里已提交 node_modules（只有 ws 一个依赖）；万一缺失则退回在线安装
RUN if [ ! -d /opt/ctyun/node_modules/ws ]; then \
      cd /opt/ctyun \
      && npm config set registry "$NPM_REGISTRY" \
      && npm install --omit=dev --no-audit --no-fund; \
    fi \
 && find /opt/ctyun/app/ecloud_engine -name '__pycache__' -type d -prune -exec rm -rf {} + || true

COPY deploy/boot.js /opt/boot.js
COPY deploy/portal  /opt/portal

RUN mkdir -p /data/ctyun /data/cmcc

EXPOSE 8555 8566 8577
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORTAL_PORT||8555)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/boot.js"]
