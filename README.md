# 拾页 · 个人工作台

一个先在本地开发、后续可部署到 VPS 的 Web 应用基础版。前端采用原生 HTML / CSS / JavaScript，后端使用 FastAPI，前后端通过真实接口连接。当前功能规模无需前端构建工具；以后可以保留这些接口并替换为 React 或 Vue。

## 已有功能

- 知伴课堂位于 `/classroom/`：40 分钟生长素探究课，教师控制五个环节、六组成果与版本、按方案分发假设结果、图片上传、受材料范围约束的 AI 指导和双组投屏；配置和操作见 [课堂使用说明](classroom-ai-prototype/README.md)。

- 注册、登录、退出；密码经过 scrypt 哈希；登录状态使用 HttpOnly Cookie，数据库仅保存令牌哈希，7 天失效。
- 每个账号独立的笔记：新建、编辑、保存、删除，刷新与重新登录后保留。
- 文件上传、列表、下载、删除；每个文件最多 10 MB，每个账号最多 100 个。下载必须登录且属于当前账号。
- AI 文本对话及历史记录；调用发生在后端，密钥不发到浏览器。使用兼容 Chat Completions 的服务接口，带最近 5 轮上下文。
- 同源请求校验、基本请求频率限制、内容安全策略；所有用户文本以纯文本显示。
- 中文自适应界面，空状态、错误反馈和未保存笔记提醒。

本地默认使用 SQLite，不需要先安装数据库。Docker Compose 版本使用 PostgreSQL，保留数据库与上传文件的独立持久化卷。

## Windows 本地启动

需要 Python 3.12 或更新版本。在本目录打开 PowerShell：

```powershell
.\start.ps1
```

也可以指定 Python：

```powershell
.\start.ps1 -Python 'C:\path\to\python.exe'
```

脚本创建虚拟环境、安装依赖并启动服务。打开 <http://127.0.0.1:8000>，首次点击“创建账号”。没有预置账号或默认密码。保持启动窗口运行，按 Ctrl+C 停止。不要双击 index.html；页面需要连接后端。

手动启动 / macOS / Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

本地数据保存在 `data/app.db` 和 `data/uploads/`。关闭网页不会删除这些数据。

## 连接 AI

在项目根目录 `.env` 中设置 `AI_BASE_URL`（以 `/v1` 等服务要求的前缀结尾）、`AI_API_KEY` 和 `AI_MODEL`，然后重启服务。具体模型名与地址使用你的服务商提供的值。留空时其他功能照常运行，AI 返回待配置提示。无需把密钥发到聊天中。

个人工作台的 AI 只接收主动发送的文字及该账号最近的对话上下文，不解析上传文件；每个账号最多 20 次 AI 请求 / 小时。知伴课堂 `/classroom/` 另支持发送选中的图片进行识图，具体限额与用法见课堂使用说明。

## VPS 部署

准备已安装 Docker 与 Compose 的 Linux VPS，域名 A / AAAA 记录正确指向服务器，开放 80 和 443 端口。仅 Caddy 对公网暴露端口，数据库与后端留在容器网络中。

1. 通过 Git 或其他方式将本目录放到 VPS。
2. 复制 `.env.example` 为 `.env`。
3. 设置 `DOMAIN` 为真实域名（不带 `https://`），`POSTGRES_PASSWORD` 为随机的十六进制长字符串，例如用 `openssl rand -hex 32` 在服务器生成。Compose 将密码放入数据库连接地址，因此不要使用含 URL 保留字符的密码。
4. 按需设置 AI 配置与 `ALLOW_REGISTRATION`。创建所需账号后，可以设置 `ALLOW_REGISTRATION=false` 并重新创建 app 容器以关闭注册。
5. 启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

Caddy 根据域名申请 HTTPS 证书。Compose 自动将 `APP_ORIGIN` 设为该 HTTPS 域名，Cookie 自动启用 Secure。后续代码更新后执行 `docker compose up -d --build`。

### 已配置的生产更新流程

生产服务器的 `/opt/edu` 已跟踪私有仓库 `fyre1998/edu` 的 `main` 分支，并使用只读 Deploy Key 拉取代码。数据库、上传文件与 `.env` 不会进入 GitHub，也不会在更新时被覆盖。

在 GitHub 的 `main` 更新后，登录 VPS 并执行：

```bash
/usr/local/sbin/edu-deploy
```

该命令只接受可快进的 Git 更新，重新构建应用容器并重启 Caddy 载入可能变更的配置。正常的开发顺序为：本地修改和测试 → 提交并推送到 GitHub `main` → 在 VPS 执行上述命令。

本地 SQLite 数据不会自动迁移至 VPS 的 PostgreSQL。若要携带本地账号和记录，应在正式使用前另做迁移，不能简单复制 SQLite 文件到 PostgreSQL 卷中。

## 备份与恢复

数据库与文件必须成对备份，并妥善保管 `.env`。以下为 Linux VPS 的维护流程，短暂停止 app 以保持一致性；数据库保持运行。

```bash
mkdir -p backups
docker compose stop app
docker compose exec -T db pg_dump -U workbench -d workbench -Fc > backups/database.dump
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" app python -c "import tarfile; t=tarfile.open('/backup/uploads.tar.gz','w:gz'); t.add('/app/data/uploads',arcname='uploads'); t.close()"
docker compose start app
```

每次备份使用不同目录或转存到另一台设备，避免覆盖唯一副本。恢复之前另存当前数据，在测试实例演练。恢复数据库时可用 `pg_restore` 导入；上传文件恢复至 app 的 `/app/data/uploads`，文件所有者需为 UID 10001。不要执行 `docker compose down -v`，它会删除持久化卷。

## 测试与边界

```bash
pip install -r requirements-dev.txt
python -m pytest tests -q
```

测试使用临时 SQLite 数据库，覆盖账号权限隔离、密码与会话、笔记持久化、文件下载与删除、上传限制、跨来源请求、AI 未配置与模拟服务、会话过期与频率限制。不会调用付费 AI。

这是可继续开发的基础版，尚无管理员角色、找回密码、邮箱验证、团队共享、文件解析或后台任务。多人使用目前指多个独立账号，并非多人协同编辑；同一账号同时编辑同一篇笔记，后保存的版本会覆盖之前的版本。

频率限制保存在单个服务进程内，重启会清空，Compose 固定一个 worker；反向代理下 IP 限制按代理 IP 共用。扩大部署前应接入共享限流存储、迁移工具和容量管理。数据库首次启动自动建表；后续结构变更需要编写迁移，`create_all` 不会升级现有表结构。

上传目前校验后缀与大小，强制作为下载附件返回，不执行或在线渲染；未提供病毒扫描。本地仅监听回环地址。

Docker 构建、PostgreSQL、HTTPS 与真实 AI 已在现有 VPS 验证。生长素课堂的本地及生产验收见 [验收记录](outputs/生长素课堂验收.md)；真实 40 分钟试教与现场负载仍需课堂验证。

浏览器支持 WebMCP 时，页面提供只读的 `list_my_notes` 工具，沿用当前登录账号权限。当前环境未做 WebMCP 实际调用验收；普通页面功能不依赖该接口。

实现参考：[FastAPI 文件上传](https://fastapi.tiangolo.com/tutorial/request-files/)、[SQLAlchemy 会话管理](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)。

