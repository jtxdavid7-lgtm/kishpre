# GTO 静态数据包

## 首个方案

- 牌局：GG Rush & Cash（Zoom）NLH，6-max，100bb
- 盲注：0.5bb / 1bb
- 开池：2.5bb
- 3-bet：IP `8bb + 2.5bb / caller`，OOP `10bb + 2.5bb / caller`
- 4-bet 及以后：75% 底池；达到 75% 有效筹码时转为全下
- 抽水：5%，cap 3bb，翻前不抽水
- Flat Drop：底池达到 30bb 时先扣除 1.5bb
- 冷跟：2-bet 后 MP / CO / BU / SB / BB 可冷跟；3-bet 后仅 BB；最多连续两次跟注
- 翻后建树：单一 33% 下注、50% 加注，用于形成翻前策略所需的后续博弈树
- 抽象：Flop 1000 / Turn 200 / River 200；只保存翻前 EV

Flat Drop 1.5bb 由用户依据 2026-07-22 的当前 GG 客户端规则确认；GG 公开页面与客户端显示存在差异，部署前仍需留存可复核证据并定期复查。

本次正式解共 2,356,695 个树节点，运行 2,835,332,758 次迭代，冻结时 Entropy 为 2.8，求解时长 18 分 53 秒。完整文件保存在本机 RocketSolver solutions 目录，大小约 532MB，不进入仓库。

站点快照现完整覆盖 2,588 个翻前决策节点，包括首次开池、冷跟、3-bet、4-bet+、再加注和全下分支。每个节点包含 169 类起手牌的行动频率、策略总 EV 和每个可选行动的 EV。

原始导出约 63MB。发布数据被转换为 2.3MB 节点索引和 21 个按需加载的 Float32 策略块，总计约 13.6MB。进入 GTO 工具时先读取索引，查看节点时才读取对应的约 0.5MB 策略块；主页和其他工具不会加载这些数据。

## 数据边界

RocketSolver 的 `.rsl` 文件是本机求解工程，不进入 Git、前端包或部署产物。站点只接入经过以下校验的 169 类起手牌频率与 EV 快照：

1. 每个节点必须包含 169 个起手牌类别；
2. 每手牌的所有行动频率之和必须为 100%（允许导出舍入误差）；
3. 全范围频率按 6 / 4 / 12 个组合数加权；
4. 节点必须保存父子关系、行动者、底池、有效筹码、下注尺度和求解元数据；
5. 全部 2,588 个翻前节点必须能从根节点遍历到达；禁止用演示频率或推测值补齐。
6. 每类手牌必须包含有限的策略总 EV、到达权重，以及每个行动的有限 EV。

本机导出与打包命令：

```powershell
$env:ROCKETSOLVER_SOLUTION='<本机 .rsl 绝对路径>'
$env:ROCKETSOLVER_OUTPUT='<临时原始 JSON 绝对路径>'
node scripts/gto/export-rocketsolver-preflop.mjs

$env:GTO_PREFLOP_RAW='<临时原始 JSON 绝对路径>'
node scripts/gto/pack-preflop-snapshot.mjs
```

可运行以下命令校验已写入仓库的快照：

```powershell
node scripts/gto/validate-static-snapshot.mjs
```

## 本地验证

```powershell
npm.cmd install
npm.cmd run dev
```

浏览器打开终端显示的本地地址，再进入 `?tool=gto`。本地开发不需要上传手牌，也不会新增手牌上传路径。

正式发布前还需要确认：求解结果用于公开商业网站展示的授权边界，以及 Flat Drop 1.5bb 的可复核规则来源。未经确认不部署该数据包。
