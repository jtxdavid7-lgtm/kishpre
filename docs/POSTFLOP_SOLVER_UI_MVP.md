# KishPoker 自研翻后 Solver 可视化 MVP

## 当前边界

本界面是本地研发工作台，不改变线上 GTO 查询器的正式数据门禁，也不把研发预览标为正式解。浏览器只调用本机 API；CFR、牌力计算、终局结算、普通抽水与额外 flat drop 仍由 `postflop-solver-gg` 执行。

默认地址：

- 网站：`http://127.0.0.1:5173/?tool=solver`
- API：`http://127.0.0.1:8788/api/v1`
- 持久化任务：`F:/kish-gto/solver-ui-runs-v1`

## 分层

```text
SolverWorkbench (React)
        |
        | JSON / HTTP, schema v1
        v
solver-ui/server.mjs
  - 输入校验与稳定 input SHA-256
  - 单进程队列、启动/停止、CPU/内存采样
  - job.json 原子持久化、重启中断识别、同输入重试
  - compact pack 解码与网站导出
        |
        | 子进程参数，不经过 shell
        v
gg_fulltree_direct_pack
  - postflop-solver-gg 原算法与抽水结算
  - compact-binary-v1 原始结果
        |
        +--> manifest.json + groups/*.f32le
        +--> website-export-v1.json (SHA-256 锁定)
```

未来嵌入网站时保留 React 与 API schema；把本地进程服务替换为受认证的任务服务即可。生产服务必须再加账号鉴权、配额、隔离执行器、对象存储和正式解发布门禁，不能直接把本机 API 暴露到公网。

## 固定动作树

首版只接受 `flop25-75-turn75-150-river33-75-150-raise75-ai50-floor-v1`：

- 翻牌下注：25%、75% pot；
- 转牌下注：75%、150% pot；
- 河牌下注：33%、75%、150% pot；
- 三条街加注：跟注后底池的 75%；
- pot-relative 尺寸向下取整到 0.01bb；
- 当行动后剩余筹码不超过行动前筹码的 50% 时，把接近筹码的尺寸替换成唯一 All-in。

动作树只通过 exporter 的显式 `--tree-policy` 选择。原有 33%/50% worker tree 仍是默认值，旧 worker bundle 与其哈希不会被覆盖。

## API v1

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 引擎、队列与固定树能力 |
| `GET` | `/jobs` | 最近 100 个持久化任务 |
| `POST` | `/jobs` | 校验输入并排队 |
| `GET` | `/jobs/:id` | 进度、exploitability、资源、错误与哈希 |
| `POST` | `/jobs/:id/stop` | 停止排队或运行任务 |
| `POST` | `/jobs/:id/retry` | 对失败、停止或中断任务创建同输入新任务 |
| `GET` | `/jobs/:id/result?node=0` | 节点列表与选中节点的 13×13 聚合矩阵 |
| `GET` | `/jobs/:id/export` | 下载自包含网站 JSON |

范围支持 solver 文本和 5,304 字节的 1,326-combo little-endian float32。上传二进制范围时不发送本地文件名。

## 本地启动

先构建包含 UI tree 与进度输出适配的 exporter：

```powershell
cargo build --release --example gg_fulltree_direct_pack `
  --manifest-path F:\kish-gto\solver-engines\postflop-solver-gg\Cargo.toml
```

然后在网站仓库分别启动 API 与 Vite：

```powershell
npm.cmd run solver:api
npm.cmd run dev -- --host 127.0.0.1
```

可用环境变量：

- `POSTFLOP_SOLVER_ROOT`
- `POSTFLOP_SOLVER_BINARY`
- `SOLVER_UI_DATA_ROOT`（Windows 上只允许 F: 或 G: 绝对路径）
- `SOLVER_UI_HOST`（默认 `127.0.0.1`）
- `SOLVER_UI_PORT`（默认 `8788`）
- `SOLVER_UI_ALLOWED_ORIGINS`（未来显式配置允许的站点源）
- `VITE_SOLVER_API_BASE`

## 结果与可复现性

每个任务目录包含：

- `job.json`：规范化输入、状态、资源采样、错误、二进制哈希和完整 argv；
- `compact-pack/`：solver 原始 `compact-binary-v1`；
- `website-export-v1.json`：所有已导出节点的 13×13 矩阵、行动频率、总 EV、行动 EV、历史与状态；
- `website-export-v1.json` 的 SHA-256 会回写到任务结果。

solver 自身 manifest 继续记录 tree/range/model hash、binary/source provenance、经济模型、覆盖率、内存估算和最终 exploitability。

## MVP 限制

- solver 始终内部求解 flop/turn/river；界面可按行动顺序查看三个街道的策略。
- Turn 与 River 使用用户指定的出牌，或按边界导出有限样本，避免一次生成数十 GB 的完整逐组合结果；未导出的分支仍参与反向求解。
- 每个已导出节点保留 1326 个具体花色组合的 reach、总 EV、行动频率和行动 EV，网页同时提供 13×13 聚合矩阵与组合明细。
- 低迭代结果是研发预览。现有验收已证明不同拓扑需要分层精度，不能仅凭进程成功或自报 exploitability 升级为正式解。
- 本地 API 只应监听 loopback；它不是公网多租户服务。
