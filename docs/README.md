# AutoPricingTool

自动核价桌面工具：读取订单 Excel 与核价表，按 **国家 + SKU + 数量档位** 匹配单价，试算覆盖率后批量写回结果。

架构为 **Electron + React** 前端与 **Rust** 子进程处理器（stdin/stdout JSONL）。

## 文档索引

| 文档 | 说明 |
|---|---|
| [处理流程与匹配规则.md](./处理流程与匹配规则.md) | 分析 → 映射 → 试算 → 执行；国家/SKU/数量/单独发货等规则 |
| [配置说明.md](./配置说明.md) | `extract_rules.json` 中实际生效的字段 |

## 当前能力（以代码为准）

- **核价键**：`(核价表国家原值, 完整主要 SKU, 最终数量档位)`；国家只忽略首尾空格和大小写，`FR-D`、`FR`、`FRD` 是不同价格路由，不做 ISO2 兜底。
- **主要 SKU**：取映射中评分最高的 SKU 组；最终数量不直接照抄该组数量，而是根据左侧最近 SKU 和受 SKU 边界限制的数量列计算。
- **数量边界**：优先取「前一 SKU 与主要 SKU 之间」最近的数量列；没有时向左回退，但左右两边都不能跨过另一 SKU 列。
- **SKU 换算**：支持相同 SKU、基础子串、`+` 组合和 `*N` 倍数；复合 SKU 按共同组件比例换算，比例冲突时数量留空并进入待确认。
- **同订单隔离**：无订单号行不参与数量或核价；吸收、同主要 SKU 合并均严格限定在同一规范化订单号内。
- **写回金额**：匹配价格写入 `核价[财务]`；若订单表存在表头为 `EU TAX` 的列，会把税额加入核价金额后再计算金额差。
- **预览编辑**：订单侧已映射的价格、SKU、原始数量和合并数量，以及新增三列均可在详情预览中编辑；执行时按编辑后的数据重新计算。
- **合计复用**：只在原工作表已有合计/汇总候选行中汇总新增三列，不创建新的合计行；预览与实际写回使用同一定位规则。
- **单独发货**：默认关闭。开启后至少选择两个联合字段；只有字段完整、联合值唯一对应一个订单且该订单只有一个有效主要 SKU 时才使用单独发货价格，否则使用通用价格。
- **空表头与定位**：映射下拉可选择空表头列；未匹配定位会在需要时加载完整预览后跳转。
- **模板**：可通过 `automation.template_match_priority` 让表头模板优先参与映射。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Electron（版本以 `package.json` 为准） |
| 前端 | React + TypeScript + Zustand + TanStack Virtual/Table |
| 构建 | electron-vite + Vite + pnpm |
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

产物：`dist-electron/AutoPricingTool.exe`（portable）。

## 目录要点

```text
AutoPricingTool/
  config/extract_rules.json     # 开发态默认可写配置
  resources/defaults/           # 打包时随程序发布的不可变默认配置
  processor-rust/src/pricing.rs # 核价核心
  processor-rust/src/pricing_writer.rs # 原工作簿写回
  src/main/                     # Electron 主进程
  src/preload/
  src/renderer/                 # UI
  docs/                         # 本文档
```

打包运行时，首次启动会把发布默认配置复制到
`%APPDATA%\auto-pricing-tool\config\extract_rules.json`；如果该文件已经存在，
程序不会用新安装包中的默认配置覆盖它。配置路径、最近输入输出目录等运行状态
以当前激活的可写配置为准。

## 文档防漂移约定

本文档不固定记录测试数量、源码行数、提交号或依赖小版本，这些动态事实分别以
测试命令、Git 和 `package.json` 为准。业务行为必须能反查到以下代码锚点：

| 行为 | 代码事实来源 |
|---|---|
| 数量列边界与 SKU 换算 | `quantity_source_columns`、`calculate_related_quantity`、`resolve_order_quantities` |
| 同订单吸收与合并 | `resolve_order_quantities` |
| 单独发货联合判断 | `single_shipment_match_columns`、`single_shipment_orders` |
| 精确档位查价 | `PriceIndex::lookup` |
| EU TAX 与金额差 | `order_tax_column_index`、`build_writeback_rows` |
| 三列写回与合计行复用 | `write_price_result`、`existing_total_row` |
| 详情预览合计与编辑 | `existingWritebackTotalRow`、`isEditableOrderSourceColumn` |

修改上述行为时，应在同一功能提交中同步更新
[`处理流程与匹配规则.md`](./处理流程与匹配规则.md)、相关测试和本索引。

## 与 Table_handle_line 的关系

同族 Electron + Rust Excel 工具。本仓库聚焦 **订单 × 核价表自动对价与写回**；批量重命名/分组汇总等能力见另一项目文档，勿与本仓库核价规则混用。
