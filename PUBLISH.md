# 发布指南（npm）

> 目标：把本插件以 `opencode-vibeguard` 的包名发布到 npm，供 OpenCode 通过 `"plugin": ["opencode-vibeguard"]` 直接安装加载。

## 0. 你需要准备

- 一个 npm 账号（已 `npm login`）
- 该包名在 npm 上可用（若被占用，可改成作用域包名，例如 `@你的scope/opencode-vibeguard`）

## 1. 发布前检查

在仓库根目录执行：

```bash
cd "opencode-vibeguard"
npm test
```

然后做一次打包预检（不发到线上）：

```bash
cd "opencode-vibeguard"
npm pack --dry-run
```

如果你遇到 `EPERM` / `root-owned files`（常见于本机 `~/.npm` 缓存权限异常），可以临时把 npm 缓存切到可写目录：

```bash
mkdir -p "/tmp/npm-cache"
cd "opencode-vibeguard"
npm_config_cache="/tmp/npm-cache" npm pack --dry-run
```

确认输出中包含：

- `package.json`
- `README.md`
- `src/*`
- `vibeguard.config.json.example`

## 2. 发布

```bash
cd "opencode-vibeguard"
npm publish
```

如遇到同样的缓存权限问题，也可临时指定缓存目录：

```bash
mkdir -p "/tmp/npm-cache"
cd "opencode-vibeguard"
npm_config_cache="/tmp/npm-cache" npm publish
```

如果是作用域包名（例如 `@xxx/opencode-vibeguard`），通常需要：

```bash
npm publish --access public
```

## 3. 发布后验证（推荐）

在任意项目里（或你的测试目录）创建/编辑 `opencode.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vibeguard"]
}
```

再放置 `vibeguard.config.json`（可从 `vibeguard.config.json.example` 复制），启动：

```bash
OPENCODE_VIBEGUARD_DEBUG=1 opencode .
```

你应看到类似日志：

- `[opencode-vibeguard] 配置：... enabled=true`
- 以及在命中时的计数日志（不会打印任何明文关键词）

## 4. 版本号建议

- 未发布过：保持 `0.1.0` 直接发
- 已发布过：每次改动后按语义化版本递增（例如 `0.1.1`）
