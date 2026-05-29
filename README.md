# auraai-packages

Monorepo for [`@auraaihq/*`](https://www.npmjs.com/settings/auraaihq/packages) npm packages. Powers the [Agent24-Desktop](https://github.com/AuraAIHQ/Agent24-Desktop) ecosystem.

## 架构定位

```
AuraAIHQ/Agent24-Desktop（Electron 框架壳）
       │  npm file: (dev) / npm registry (prod)
       ▼
AuraAIHQ/auraai-packages（本仓库）
       │
       ├── packages/   内核层（框架直接依赖，随框架打包进 app）
       │   ├── @auraaihq/core        模块加载 / 生命周期管理
       │   ├── @auraaihq/sdk         模块开发 API
       │   ├── @auraaihq/memory      L0 KV 存储（SQLite）
       │   ├── @auraaihq/ai-bridge   AI 多适配器路由
       │   └── @auraaihq/cli         命令行工具（独立，不进 app）
       │
       └── publishers/ scrapers/ community/ idoris/
                      可插拔能力模块（按需引入）
           ├── @auraaihq/publish-blog      博客发布（参考实现）
           ├── @auraaihq/publish-xiaohongshu / publish-*
           ├── @auraaihq/scrape-web / scrape-rss / scrape-*
           ├── @auraaihq/module-identity / wallet / comm
           └── @auraaihq/idoris-input / process / query / create
```

## packages/ 各包说明

| 包 | 角色 | Desktop 依赖类型 | 职责 |
|----|------|-----------------|------|
| `@auraaihq/core` | 内核 | runtime，打包进 app | 模块注册/load/unload/invoke，生命周期状态机，依赖图排序 |
| `@auraaihq/sdk` | 模块开发 API | devDependency（模块开发者） | `defineModule`、`ModuleManifest`、`MemoryHandle`、`AIHandle`、错误码类型 |
| `@auraaihq/memory` | L0 记忆层 | runtime，打包进 app | SQLite KV 存储，命名空间隔离，`get/set/has/list/namespace/close` |
| `@auraaihq/ai-bridge` | AI 路由层 | runtime，打包进 app | 多适配器统一接口，优先级 fallback，并发信号量，usage 校验 |
| `@auraaihq/cli` | 命令行工具 | 独立，不进 app | 开发者脚手架，模块打包，发布辅助 |

## 仓库目录结构

```
auraai-packages/
├── packages/      内核 + SDK + 工具（紧耦合）
├── community/     社区模块 (cos72, myshop, mytask, myvote)
├── publishers/    发布器模块 (publish-blog, publish-xiaohongshu, ...)
├── scrapers/      抓取器模块 (scrape-web, scrape-rss, ...)
└── idoris/        iDoris 能力包装 (input, process, query, create)
```

详见 [Agent24-Desktop/docs/PLAN.md](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/PLAN.md) 和 [decision.md](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/decision.md)。

## 命名规则

| 前缀 | 含义 | 示例 |
|------|------|------|
| 无前缀 | 内核 / SDK / 工具 | `@auraaihq/core`, `@auraaihq/cli` |
| `ai-` | AI 模型适配器 | `@auraaihq/ai-claude` |
| `models-` | 模型 metadata（不含权重）| `@auraaihq/models-vision` |
| `module-` | 基础能力模块 | `@auraaihq/module-identity` |
| `publish-` | 发布器模块 | `@auraaihq/publish-blog` |
| `scrape-` | 抓取器模块 | `@auraaihq/scrape-rss` |
| `idoris-` | iDoris 能力包装 | `@auraaihq/idoris-query` |
| `skills-` | Claude Code skill（M3+）| `@auraaihq/skills-evolve` |

## Development

```bash
pnpm install           # 安装所有 workspace 依赖
pnpm build             # turbo 编排构建所有包（带增量缓存）
pnpm typecheck         # turbo 编排类型检查（带增量缓存）
pnpm test              # 运行所有测试（vitest projects 模式，单进程，最快）
pnpm test:turbo        # turbo 编排测试（每包独立进程，可缓存）
pnpm test:watch        # 测试 watch 模式
pnpm test:coverage     # 测试 + 覆盖率报告
pnpm bench             # 运行 benchmarks（vitest bench）
pnpm clean             # 清理所有 dist/ 和缓存
pnpm --filter @auraaihq/core build   # 单包构建
```

**新增包必须**包含 `vitest.config.ts`，否则会被 root vitest 和 turbo 静默排除（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

**turbo 编排**：构建/typecheck 通过 [turbo](https://turborepo.com) 调度，自动增量缓存（重跑未变更的包瞬间完成）。配置见 `turbo.json`。

**`pnpm test` vs `pnpm test:turbo`**：
- 日常开发：`pnpm test`（vitest projects 模式，单进程，启动最快、输出最清晰）
- CI：`pnpm test:turbo`（每包独立进程 + turbo 缓存，重复 PR 推送时未变更包直接命中缓存）

## Versioning & Publishing

使用 [changesets](https://github.com/changesets/changesets) 管理版本与 CHANGELOG。**Independent versioning**——每包独立版本号。

```bash
pnpm changeset   # 描述改动，选择影响包和 bump 类型
# commit .changeset/*.md 文件到 PR
pnpm version     # 合并后更新版本号 + CHANGELOG
pnpm release     # 发布到 npm
```

M0 阶段所有包标记为 `"private": true`，M1 构建完成后翻开。翻开前 checklist 见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

Apache-2.0
