# Multiplex PCR Pool Allocator

定版前的多重 PCR 面板分池服务。把 8–18 个扩增子**精确**(非贪心)分入 2–4 个并行反应池,
在满足硬约束的前提下按四级目标词典序寻优。

- 运行时零第三方依赖:Node.js 内置 `node:http` + 全局 `fetch`。
- 求解器为带剪枝的精确分支限界(Branch & Bound),不是逐项放入最空池的贪心算法;
  结果在第四级目标意义下唯一且可复现。

## 硬约束

每个请求都必须满足,否则返回 `422` 并给出冲突摘要:

1. 每个扩增子恰好分入一个池。
2. 每个池的总负载落在统一闭区间 `loadRange: [min, max]` 内。
3. 每个池至少含一个对照扩增子(`control: true`)。
4. 风险分 `>= forbiddenThreshold` 的配对**不得同池**;未列出的配对风险视为 0。
   因此阈值为 `0` 时任意配对都被禁配。

## 优化目标(严格词典序,依次最小化)

1. **单池最高风险和** `maxPoolRisk`
2. **全部池风险总和** `totalRisk`
3. **池间负载极差** `loadRangeSpread`(最大池负载 − 最小池负载)
4. **按扩增子录入顺序展开的池号序列**(1 基池号、逐位字典序)

第 4 级用于在所有前序指标持平时给出唯一、稳定、可复现的分池。池标签按
"录入顺序中首次出现"规范化,因此池号没有任意性。

## 运行

### Docker Compose

```bash
APP_PORT=8080 docker compose up --build app     # 宿主机端口由 APP_PORT 决定(默认 3000)
```

健康检查:`GET /health` → `200 {"status":"ok"}`。

### 本地

```bash
npm install
npm run build          # TypeScript 构建到 dist/
APP_PORT=3000 npm start
```

## API

### `POST /api/pools/allocate`

请求字段:

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `amplicons` | 数组,长度 8–18 | 每项 `{id(唯一非空字符串), load(正整数), control(布尔)}` |
| `poolCount` | 整数 | 2–4 |
| `loadRange` | `{min, max}` | 均为正整数且 `min <= max` |
| `risks` | 数组 | 无序配对 `{a, b, risk}`,`a/b` 为已声明的不同扩增子,`risk` 为非负有限数,配对不重复 |
| `forbiddenThreshold` | 数 | 非负有限 |

成功 `200`(节选):

```json
{
  "status": "feasible",
  "allocation": {
    "poolCount": 2,
    "pools": [
      {
        "pool": 1,
        "members": ["A0", "A1"],
        "load": 20,
        "controls": ["A0"],
        "risks": [{ "a": "A0", "b": "A1", "risk": 3, "pool": 1 }],
        "riskSum": 3
      }
    ],
    "maxPoolRisk": 3,
    "totalRisk": 3,
    "loadRangeSpread": 0,
    "assignment": [{ "id": "A0", "pool": 1 }]
  }
}
```

- `pools[].members` / `controls` 按扩增子录入顺序排列。
- `pools[].risks` 只列出同池且风险分大于 0 的配对;达阈值的禁配对不会出现。
- `assignment` 严格按录入顺序给出每个扩增子的 1 基池号。

非法输入返回 `400`,每个问题都定位到字段:

```json
{ "error": "validation_failed", "fields": [{ "field": "amplicons[3].load", "message": "..." }] }
```

合法但约束不可满足返回 `422`,带可读原因与冲突摘要(如禁配边列表、对照缺口、
总负载上下界冲突、阈值为 0 全禁配等):

```json
{
  "status": "infeasible",
  "message": "no feasible pool assignment exists for this request",
  "conflict": {
    "reason": "forbidden-pair graph cannot be colored with 2 pool(s): ...",
    "unsatisfiableForbiddenPairs": [{ "a": "A", "b": "B", "risk": 9 }]
  }
}
```

只有在**已证明**约束无解时才返回 `422 status=infeasible`。若精确搜索在给出
无解方程之前耗尽节点/时间预算,接口**不会**把它当作无解:此时返回

`503`:

```json
{
  "status": "undetermined",
  "message": "the solver exhausted its search budget before feasibility could be proven or disproven; this does NOT mean no feasible assignment exists",
  "conflict": {
    "reason": "...",
    "searchLimitReached": true,
    "resourceLimits": { "nodeLimit": 3000000, "timeLimitMs": 8000 }
  }
}
```

`undetermined` 表示"尚未裁决",不是"无可行分池";调用方不得据此拒绝面板。
边界规模(18 项、4 池、稠密风险图)由组合式风险下界在预算内精确完成,
正常返回 `200`,不会落到 `503`。

## 一次性 verify 服务

`verify` 是一次性容器:等待 `app` 健康后,依次执行并**自行退出**,
退出码为失败阶段的位掩码(`0` 表示全部通过):

| 位 | 阶段 |
| --- | --- |
| 1 | 单元测试(`npm test`,含对暴力枚举参照实现的逐案最优性比对) |
| 2 | TypeScript 构建(`npm run build`) |
| 4 | 等待应用 `/health` 健康 |
| 8 | 线上 API 核对(含**非贪心陷阱**、18 项稠密风险边界、不可行 422、非法输入 400、稳定性复测);预算未决 503 语义由单元测试覆盖 |

```bash
docker compose up --build --abort-on-container-exit --exit-code-from verify verify
```

该命令会先构建并启动 `app`,通过健康检查后运行一次性 `verify`,
`verify` 完成后自动退出,退出码透传给 shell(`0` 即全部通过)。

本地等价运行(应用已在本机监听):

```bash
APP_BASE_URL=http://127.0.0.1:3000 npm run verify
```

### 非贪心陷阱

verify 的核心用例中,8 个负载均为 5 的扩增子分入 2 池、每池负载上限 20。
若按"逐项放入当前最空池"会得到 `1,2,1,2,...`,使风险 100 的 `A0–A2` 同池;
精确求解器则把它们拆开,得到 `maxPoolRisk = 0` 的最优分池。

## 目录

```
src/        types / validation / solver(精确 B&B)/ app(HTTP)/ server
tests/      node:test 单元测试(含暴力枚举最优性比对)
verify/     一次性校验服务与压力脚本
Dockerfile  build → runtime(零依赖,带 HEALTHCHECK)→ verify 三阶段
```
