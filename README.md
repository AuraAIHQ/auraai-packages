# auraai-packages

Monorepo for [`@auraaihq/*`](https://www.npmjs.com/settings/auraaihq/packages) npm packages. Powers the [Agent24](https://github.com/AuraAIHQ/Agent24) and [Agent24-Desktop](https://github.com/AuraAIHQ/Agent24-Desktop) ecosystem.

## Structure

```
packages/      # 内核 + AI 适配 + memory + base modules（紧耦合）
community/     # 社区模块 (cos72, myshop, mytask, myvote)
publishers/    # 发布器模块 (publish-blog, publish-xiaohongshu, ...)
scrapers/      # 抓取器模块 (scrape-web, scrape-rss, ...)
idoris/        # iDoris 能力包装 (input, process, query, create)
```

详见 [Agent24-Desktop/docs/PLAN.md](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/PLAN.md) 和 [decision.md](https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/decision.md)。

## 命名规则

| 前缀 | 含义 |
|------|------|
| 无前缀 | 内核 / SDK / 工具（`@auraaihq/core`, `@auraaihq/cli`） |
| `ai-` | AI 模型适配器 |
| `models-` | 模型 metadata（不含权重）|
| `module-` | 基础模块 |
| `publish-` | 发布器模块 |
| `scrape-` | 抓取器模块 |
| `idoris-` | iDoris 能力包装 |
| `skills-` | Claude Code skill |

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

**turbo 编排**：构建/typecheck 通过 [turbo](https://turborepo.com) 调度，自动增量缓存（重跑未变更的包瞬间完成）。配置见 `turbo.json`。

**`pnpm test` vs `pnpm test:turbo` 选择**：
- 日常开发：用 `pnpm test`（vitest projects 模式，单进程，启动最快、输出最清晰）
- CI 跑测试：用 `pnpm test:turbo`（每包独立进程 + turbo 缓存，重复 PR 推送时未变更的包能直接命中缓存）

二者使用同一份 vitest config（每包 `vitest.config.ts`），不存在 drift。

**测试约定**：

- 文件位置：`<group>/<pkg>/src/**/*.{test,spec}.?(c|m)[jt]s?(x)`（test 与 spec 都识别）
- benchmarks：`<group>/<pkg>/src/**/*.{bench,benchmark}.?(c|m)[jt]s?(x)`，由 `pnpm bench` 触发
- 配置：根 `vitest.config.ts` 管 coverage + projects；每包自己的 `vitest.config.ts` 决定 environment / include 等局部行为
- Projects：根 vitest 跨 `packages/community/publishers/scrapers/idoris` 五个 group 自动发现各包的 `vitest.config.{ts,js,mjs}`

## Versioning & Publishing

使用 [changesets](https://github.com/changesets/changesets) 管理版本与 CHANGELOG。**Independent versioning**——每包独立版本号。

```bash
# 1. 改动代码后，添加一条 changeset
pnpm changeset
# 交互式选择影响哪些包 + bump 类型 (patch/minor/major) + 写描述

# 2. 在 PR 中 commit `.changeset/*.md` 文件

# 3. 合并到 main 后，跑 version 命令更新版本号 + CHANGELOG
pnpm version

# 4. 发布到 npm
pnpm release
```

`access: public` 已配置，但 M0 阶段所有包标记为 `"private": true`——避免在没有真正 build pipeline 之前误发 `.ts` 入口。M1 实现真正构建后再翻开 private 标志。

> **⚠️ 翻开 private 前的 checklist**（手动或 CI 检查）：
> - `dist/` 目录存在且包含 `index.js`
> - `package.json` 的 `main` 指向 `dist/`，不是 `src/`
> - `package.json` 的 `exports`（如有）也指向 `dist/`
> - `package.json` 的 `files` 改为 `["dist", "README.md", "LICENSE"]` —— 不再发 `src/`（避免发布测试文件）
> - `tsconfig.build.json` 跑过 `noEmitOnError: true` 校验
> - `LICENSE` 文件存在（已加入各包）

## License

This project is licensed under the [Apache License, Version 2.0](LICENSE).  
Copyright 2024-present MushroomDAO Contributors. See [NOTICE](./NOTICE) for attribution.
