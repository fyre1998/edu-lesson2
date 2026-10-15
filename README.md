# 生物探究课堂 · 第二节课

第二节课的独立开发项目，复用第一课的 FastAPI 后端和 HTML / CSS / JavaScript 前端。新建课次的教学内容已按《植物激素10.2.pptx》和《植物激素 学习任务单10.2.docx》实现：根据实验设计提供百粒质量、葡萄增产方案拍照评价。

## 项目与发布目标

| 项目 | 第二课配置 |
|---|---|
| 本地目录 | `D:\codex project\lesson2_edu` |
| GitHub 私有仓库 | [fyre1998/edu-lesson2](https://github.com/fyre1998/edu-lesson2) |
| 本地课堂 | <http://127.0.0.1:8015/classroom/> |
| 本地数据 | `data/lesson2/app.db` 与 `data/lesson2/uploads/` |
| Compose 项目名 | `edu-lesson2` |
| 线上课堂 | `https://lsclass.top/lesson/` |
| 线上个人工作台 | `https://lsclass.top/lesson/workspace/` |
| 服务器目录 | `/opt/edu-lesson2` |
| 专用上线命令 | `/usr/local/sbin/edu-lesson2-deploy` |

源代码继承自第一课 `fyre1998/edu` 的提交 `4f4d1b11468759a8d3d185f574e3099f594cc02d`。本项目的 `origin` 为第二课仓库，原项目目录与第一课仓库配置保持不变。

## 启动本地课堂

在当前电脑双击根目录的 `启动本地课堂.cmd`。程序在后台运行，确认项目身份后自动打开第二课网页；再次双击会复用当前第二课服务。

- 课堂邀请码：`BIO-LESSON2`。
- 教师姓名：赵老师或王老师。
- 本机已设置独立教师密码，见 `.local/lesson2-access.txt`；该文件与 `.env` 均不进入 Git。
- 第一次打开没有课次，教师登录后创建新课。新课默认使用植物激素两环节、六组教学模板（flow_version=5，10.2版）。已有进行中的10.2版课次同步调整为六组，原有数据保留；归档课次继续按原组数展示。

需要在终端运行并用 Ctrl+C 停止时：

```powershell
.\start.ps1
```

`start.ps1` 会安装依赖并使用同一启动器；如需指定 Python 3.12+，传入 `-Python 'C:\path\to\python.exe'`。新电脑首次复制 `.env.example` 为 `.env` 后，应设置 `CLASSROOM_TEACHER_PASSWORD`；AI、语音服务沿用配置中的服务端密钥。

其他平台创建虚拟环境、安装 `requirements.txt`、准备 `.env` 后执行：

```bash
python scripts/start_classroom_preview.py --foreground
```

高级用法：启动器的 `--port` 参数与 PowerShell 的 `-Port` 参数可指定其他端口。默认 8015 使用 `data/lesson2/`，其他端口使用 `data/lesson2-端口号/`，不会读取复制的旧预览数据。不要直接双击 HTML 文件。

## 数据与运行隔离

- 第二课数据库、上传文件、启动日志和后台进程编号均在 `data/lesson2/`。
- 复制来的 `data/app.db`、`data/uploads/` 和 `work/` 原样保留作参考；第二课启动入口不使用这些旧数据。
- 工作台与课堂分别使用 `lesson2_session`、`lesson2_classroom_session` Cookie，避免同一浏览器同时打开两节课时互相覆盖登录。
- 启动器核对健康接口中的应用标识与数据目录对应的实例标识；端口被第一课或其他服务占用时会报错。
- 本地服务只监听 `127.0.0.1`。关闭网页不会删除数据，也不会停止后台服务。
- `.local/lesson1-reference/` 保存随项目复制的第一课连接资料，仅留作参考，不应作为第二课发布目标。

## 现有功能

保留小组登录、拍照、语音输入、AI 对话、草稿与提交历史、AI 评价及历次分数、教师观察与单组投屏、问题汇总。原个人工作台在 `/`，支持账号、笔记、文件和文字对话。

当前课程模板、材料权限及具体课堂操作见 [课堂使用说明](classroom-ai-prototype/README.md)。`outputs/` 内早于本次项目隔离的验收记录继承自第一课，不能作为第二课上线完成的依据。

第二课速度优先配置为 `AI_MODEL=deepseek/deepseek-v4.1-flash`、`AI_REASONING_EFFORT=low`、`AI_MAX_TOKENS=8192`，用于图片识别、课堂对话、方案评分与教师汇总。固定使用 V4.1 Flash，不使用会随时间更新的 latest 别名。`AI_PROVIDER_SORT=throughput` 在 OpenRouter 上优先选择输出较快的服务商，同时保留严格 JSON 支持和服务商故障回退；留空沿用默认路由，其他接口不发送该参数。简单文字处理继续直接匹配课件数据，无需等待 AI。语音转写仍由 `STT_MODEL` 单独配置。

## AI 自动备用线路

启用 `AI_FAILOVER_ENABLED=true` 后，主模型故障时使用百炼直连 `AI_FALLBACK_MODEL=qwen3.8-flash`，只读取 `DASHSCOPE_API_KEY`。启用 `STT_FAILOVER_ENABLED=true` 后，千问官方语音故障时使用 OpenRouter 的 `STT_FALLBACK_MODEL=qwen/qwen3-asr-0.6b`；语音备用密钥可独立设置 `STT_FALLBACK_API_KEY`，留空使用 `AI_API_KEY`。两种服务的密钥不会互相发送。保持单进程单 worker 部署。

故障切换按固定顺序串行尝试；同一上下文、图片、评分量规和请求编号贯穿全过程。备用不会收到主模型的失败片段。启用后，对话等待完整生成和校验，只发送最终确认的回复；网络中断后重试沿用同一请求编号。模型结果须通过 JSON Schema 校验，业务层继续校验实验条件和评分证据；评分以提交版本为唯一键，已完成评分不会因切换重算。备用模型若返回不合格 JSON，可在同一总时限内进行一次格式修复请求；原始上下文不变，不把失败内容加入历史。备用语音遇到临时网络错误、限流或服务端故障时可在同一总时限内重试一次。格式错误不触发全班线路暂停。两条线路统一使用 temperature=0 减少随机性，但不同模型的判断仍可能有差异，教师可以复核。

连接超时为 4 秒。对话 10 秒未收到内容可转备用，每条线路完整生成最多 25 秒；图片识别、评分和汇总每条线路最多 40 秒；整次 AI 调用最多 85 秒。语音主线路按录音时长分配约 10–24 秒，备用最多 30 秒，两条线路合计最多 65 秒（录音解码另有 20 秒上限）。这些是截止时间，不是速度承诺；故障立刻返回时立即尝试备用。主备都失败时保留原记录并明确报错，不生成伪造结果。

对话、结构化任务、语音分别记录故障线路。默认暂停 60 秒；可用带时区的 `AI_FAILOVER_HOLD_UNTIL` 将主线路的暂停延长到公开课结束后，例如 `2026-10-16T09:05:00+08:00`。暂停只由实际失败触发，正常主线路继续使用；备用本身失败仅暂停 60 秒。若主线路正在暂停，而本次实际尝试的备用也失败，只在本次总时限内应急尝试主线路一次；成功后解除主线路暂停，失败则保留暂停，每条线路在同一请求中只进入一次。备用健康时不主动回切，两条线路都暂停时不连续探测。状态文件位于数据卷的 `ai-circuits.json`，重启仍保留，日期过后恢复常规冷却。日志 `ai_failover` 仅包含模型、请求追踪编号、尝试、耗时和状态，不记录学生内容或密钥。此文件和进程锁仅适用于当前单 worker，不能直接扩展为多副本。

需要关闭自动备用时，将两项 `*_FAILOVER_ENABLED` 改为 `false` 并重新创建应用容器，即恢复原调用路径。模型服务冗余不替代数据库、网站入口和教室网络的保障。

自动故障演练：`python -m pytest tests/test_resilience.py -q`。真实验收脚本为 `scripts/verify_ai_failover.py`，使用人工构造的图片/录音 JSON（`image`、`audio` 为 Base64），在独立临时数据库中运行六组看图、两轮对话、评分、汇总、语音和重复请求；`--force-backup` 只在该测试进程内模拟主服务故障。示例：`python scripts/verify_ai_failover.py --fixtures /path/to/synthetic-fixtures.json --output /path/to/report.json --force-backup`。真实验收会产生模型费用，禁止向正式课堂写入演练成果。

## 千问官方语音识别

学生语音输入和教师图表口述共用 `/api/classroom/transcriptions`。在服务端 `.env` 配置：

```dotenv
STT_PROVIDER=dashscope
STT_MODEL=qwen-audio-3.1-asr-flash-message
DASHSCOPE_API_KEY=填写北京地域的百炼APIKey
DASHSCOPE_REGION=cn-beijing
DASHSCOPE_WORKSPACE_ID=
```

`DASHSCOPE_WORKSPACE_ID` 可填写百炼业务空间 ID，以使用专属域名；留空使用北京公共域名 `dashscope.aliyuncs.com`。新加坡密钥需将地域改为 `ap-southeast-1`。此路径只读取 `DASHSCOPE_API_KEY`（或专用的 `STT_API_KEY`），不使用课堂对话的 `AI_API_KEY`，不把密钥发送到浏览器。

安装 `requirements.txt` 后重启服务；Docker 部署需重新构建并创建应用容器，且服务器 `.env` 需要单独配置密钥。`imageio-ffmpeg` 在支持的平台随安装包提供 FFmpeg，无需把录音保存到磁盘。浏览器的 WebM、Ogg、MP4/M4A 和 WAV 录音会在内存中转换成 16 kHz 单声道 PCM，由后端通过 WebSocket 发送给千问，收到最终文字后沿用现有发送或填入草稿流程。仍保留 90 秒录音限制、身份校验、限流、重复请求去重和最多 8 段并行转写。

协议依据：[WebSocket 接入](https://help.aliyun.com/zh/model-studio/qwen-asr-message-websocket-api)、[客户端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-message-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-message-server-events)。自动化测试使用本地模拟服务；真实识别效果和账号权限需要配置有效 Key 后验证。

需要沿用原语音供应商时，配置 `STT_PROVIDER=openrouter` 和对应的 `STT_MODEL`、`STT_BASE_URL`、`STT_API_KEY`。

## 测试

结果识别和成果评分各允许8个后台任务同时执行，合计最多16个；课堂聊天、教师汇总和语音转写另行运行。应用连接池按需建立最多30个连接（`DB_POOL_SIZE=20`、`DB_MAX_OVERFLOW=10`），给后台任务和页面请求留出余量。内存SQLite保留原有连接池。修改配置后需要重启本地服务，Docker部署需重新创建应用容器；每个worker或副本各有独立连接池，扩容时应核对所有进程的连接总预算和数据库的`max_connections`，为管理连接留出空间。

```powershell
.venv\Scripts\python.exe -m pytest tests -q
node --test classroom-ai-prototype/*.test.cjs
```

自动测试使用临时数据库和模拟 AI，不调用付费模型。项目隔离测试覆盖两课登录 Cookie 互不覆盖、错误服务占用端口时拒绝启动，以及健康接口身份。

## 第二课上线

本地修改和测试后，提交并推送本仓库的 `main` 分支，再登录 VPS 执行：

```bash
/usr/local/sbin/edu-lesson2-deploy --check
/usr/local/sbin/edu-lesson2-deploy
```

脚本固定使用 `/opt/edu-lesson2`、`fyre1998/edu-lesson2` 的 `main` 和 Compose 项目名 `edu-lesson2`，更新前检查工作区和发布目标，只允许快进更新。服务器独立的校验器还检查主域名、`/lesson` 前缀、数据卷、网络和端口，防止引用第一课数据。`--check` 只检查，不拉取、构建或重启。

第二课使用 `docker-compose.yml` 与 `deploy/compose.production.yml` 两份配置。仅运行 app/db，数据库卷为 `edu-lesson2_postgres`，上传卷为 `edu-lesson2_uploads`；不发布宿主机端口。app 通过 `edu_gateway` 网络上的唯一别名 `edu-lesson2-app` 接入共享 Caddy，db 只连接本课私有网络。继承的根目录 `Caddyfile` 不用于此部署。

服务器共享入口配置由 `/etc/edu-gateway/Caddyfile` 与 `/etc/edu-gateway/lessons/` 管理，独立于两课代码仓库。`deploy/lesson2.caddy` 是需导入现有 `lsclass.top` 站点块内的路径配置，实际放在 `/etc/edu-gateway/lessons/routes/lesson2.caddy`。它将 `/lesson/` 下的请求去掉前缀后转发给第二课；其余路径仍由第一课处理。每次更新第二课不会重启或覆盖 Caddy，也不会更新第一课。第一课的原 `edu-deploy` 命令继续使用 `/opt/edu`，通过 `/etc/edu-deploy/lesson1.override.yml` 保留共享入口挂载。

已有第二课数据时，上线脚本会先短暂停止本课 app，备份数据库、上传文件、环境配置和代码版本，再启动旧服务并构建新版。备份位于 `/var/backups/edu-lesson2/`。构建失败时保留旧应用；新版启动失败会报错，需要按备份和记录的上一提交排查恢复，不会自动回退数据库。不要执行 `docker compose down -v`。

该方案使用同一域名下的子路径，无需新增 DNS 或证书。生产 `.env` 使用 `DOMAIN=lsclass.top`、`APP_ORIGIN=https://lsclass.top`、`APP_BASE_PATH=/lesson`。第二课的接口、图片和下载路径均保留 `/lesson` 前缀；登录 Cookie 限定 `Path=/lesson`，草稿使用第二课独立命名。两课同属一个浏览器来源，并非浏览器安全边界；服务端课程数据和运行环境仍保持独立。

服务器的 `.env` 与 `.local/production-access.txt` 不进入 Git。第二课不能使用第一课的 `/opt/edu` 目录或 `edu-deploy` 命令。
