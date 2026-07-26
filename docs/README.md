# AutoPricingTool

自动核价桌面工具：读取订单 Excel 与核价表，按 **国家 + SKU + 数量档位** 匹配单价，试算覆盖率后批量写回结果。

架构为 **Electron + React** 前端与 **Rust** 子进程处理器（stdin/stdout JSONL）。

## 文档索引

| 文档 | 说明 |
|---|---|
| [处理流程与匹配规则.md](./处理流程与匹配规则.md) | 分析 → 映射 → 试算 → 执行；国家/SKU/数量/单独发货等规则 |
| [配置说明.md](./配置说明.md) | `extract_rules.json` 中实际生效的字段 |

## 最新能力（与代码同步）

- **核价键**：`(国家 ISO2, SKU, 数量档位)`；**不再**使用物流方式参与匹配，也不再从国家单元格拆「后缀物流」。
- **国家整格识别**：`UNITED STATES` 可解析为 `US`；`UNITED STATES-hold` 整格不在目录中则**不入库、不匹配**。
- **SKU 三元组**：订单侧为「原始数量 → SKU → 合并数量」列顺序（中间可夹其他列，不必相邻）。
- **写回数量**：同一订单号 + 同一 SKU 的数量全局汇总（不限是否相邻行）。
- **空表头**：映射下拉可选「空表头」列；数量列允许空表头。
- **未匹配定位**：开启时若尚未加载全部数据，会触发一次 `loadAll` 再定位未匹配行。
- **单独发货**：订单侧按「同值是否仅对应一单」判定；核价表中「单独发货价格」标记行之后走单独发货价表，失败再回退标准价表。
- **模板**：可选表头模板优先匹配（`automation.template_match_priority`）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Electron 43 |
| 前端 | React 19 + TypeScript + Zustand + TanStack Virtual/Table |
| 构建 | electron-vite + Vite 7 + pnpm |
| 处理器 | Rust（calamine / ZIP XML 读表 + 写回） |
| 打包 | electron-builder portable EXE |
| 测试 | Vitest（UI）/ `cargo test`（处理器） |

## 架构

```text
┌────────────────────────────────────────────────────────────┐
│ Electron                                                   │
│  Main (index.ts) ──IPC── Preload ── Renderer (React)       │
│       │ spawn                                              │
│       ▼                                                    │
│  auto-pricing-tool-processor.exe                           │
│  stdin:  JSON 命令行   stdout: JSON 事件行                  │
└────────────────────────────────────────────────────────────┘
```

主要命令（Rust `action`）：

| action | 用途 |
|---|---|
| `scan` / `start` / `merge-summaries` | 兼容扫描/批处理/合并（沿用表格工具链路） |
| `price-check-analyze` | 识别订单/核价 Sheet、生成映射与试算 |
| `price-check-validate` | 用户改映射后重试算 |
| `price-check-run` | 按映射与写回数据生成结果文件 |
| `pause` / `resume` / `stop` / `shutdown` | 控制子进程 |

## 启动

### 开发

```powershell
pnpm install
pnpm dev
```

`predev` 会以 Dev 模式编译 Rust 处理器。开发态前端默认 `http://localhost:5173/`。

### 测试与质量

```powershell
pnpm test                 # 处理器 + UI
pnpm run test:processor
pnpm run test:ui
pnpm run typecheck
pnpm run quality          # fmt/clippy/typecheck/test/build
```

### 打包

```powershell
pnpm run dist:win
```

产物：`dist-electron/AutoPricingTool_latest.exe`（portable）。

## 目录要点

```text
AutoPricingTool/
  config/extract_rules.json     # 本机运行配置（可含路径记忆）
  resources/defaults/           # 发布默认配置
  processor-rust/src/pricing.rs # 核价核心
  src/main/                     # Electron 主进程
  src/preload/
  src/renderer/                 # UI
  docs/                         # 本文档
```

## 与 Table_handle_line 的关系

同族 Electron + Rust Excel 工具。本仓库聚焦 **订单 × 核价表自动对价与写回**；批量重命名/分组汇总等能力见另一项目文档，勿与本仓库核价规则混用。
