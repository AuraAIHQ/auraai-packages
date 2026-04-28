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
pnpm -r build          # 构建所有包
pnpm -r typecheck      # 类型检查
pnpm --filter @auraaihq/core build   # 单包构建
```

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

`access: public` 已配置，所有 `@auraaihq/*` 包默认公开发布。

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
