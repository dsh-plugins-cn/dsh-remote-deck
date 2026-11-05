# 维护与迭代手册

面向后续版本（v1.1、v2…）的操作说明。发布对外步骤见 [PUBLISH.md](PUBLISH.md)，界面设计稿在
`docs/design/v2/`（脱敏设计稿与渲染截图）。

## 1. 目录与数据

| 内容 | 位置 |
| --- | --- |
| 源码 | `<repo>` |
| 插件数据（连接、stub、转发） | `<DSH_HOME>\remote-deck` |
| 旧插件数据（只读复用） | `<DSH_HOME>\remote-ssh` |
| 测试 profile | `<DSH_HOME>\profiles\deckcheck` |
| 桌面 profile | `<DSH_HOME>\profiles\desktop`（当前仍是旧插件） |
| 离线包 | `dist\dsh-remote-deck-<版本>.zip` |
| 内置依赖 | `vendor/node_modules`（ssh2 等）、`vendor/xterm` |

## 2. 版本迭代流程

1. 改代码（`index.js` / `lib/*` / `client.js` / `vendor` 不动）。
2. 同步版本号，两处必须一致（`check-manifest` 会拦住不一致）：
   - `package.json` 的 `version`；
   - `index.js` 的 `const BUILD = '<version>'`。
3. 更新 `CHANGELOG.md`：新版本小节 + 变更分类（Added/Fixed/Changed/Known limits）。
4. 更新 `ROADMAP.md`：把该版本标为已完成，调整后续计划。
5. 若改了界面：改 `docs/design/v2/` 后重新渲染 `01.png`–`06.png`，并更新 README 截图。
6. 本地验证：
   ```powershell
   npm run check
   npm test
   npm run pack:dry
   ```
7. 装进测试 profile 实测（不要先装桌面）：
   ```powershell
   .\install.ps1 -Profile deckcheck
   # 启动测试 host 后跑一遍连接、工作区、终端、端口
   ```
8. 发布：
   ```powershell
   .\scripts\release.ps1 -Tag      # 校验 + 打包 + 打 tag（不推送、不发布）
   git push origin main
   git push origin v<version>      # release.yml 自动建 GitHub Release 并附 tgz
   ```
9. 桌面切换/回滚见 PUBLISH.md 第 5 节。

## 3. 截图验收流程

1. 用测试 profile 启动 host（见 `scripts/shot.mjs` 的用法注释）。
2. 用 `scripts/eval.mjs` 操作页面（点击、打开面板/控制台/标签）。
3. 用 `scripts/capture.mjs` 在不跳转的情况下截图（用于切换主题后的画面）。
4. 与 `docs/design/v2/0x.png` 并排比对：间距、字号、圆角、层级、空态、深浅色。
5. 有偏差就写进 `docs/design/v2/spec.md` 的偏差小节，必须修的在发布前清零。

> 验证脚本会调用页面上的调试挂载（`__RD_OPEN_CONSOLE__`、`__RD_STORE__`、`__RD_TERM__`）。
> 这些只在开发/验收时使用，不影响正常功能。

## 4. 调试

- `DSH_REMOTE_DECK_DEBUG=1`：host 打印 API 端口、token、连接与转发日志。
- `install.ps1 -Doctor -Profile <name>`：检查 bundle 状态、版本/BUILD、连接/工作区/转发数量。
- 页面报错：验收脚本会输出 `page errors`；也可在 DSH 开发者工具里看 console。
- 连接失败：控制台顶部会显示原始错误；`-Doctor` 看数据目录是否正常。

## 5. 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 插件"消失" | profile 的 `bundles`/`dependencies` 被重写。跑 `install.ps1 -Profile <name>` 恢复；`-Doctor` 可确认 |
| `dsh plugin add` 失败（ignored builds） | 包内已内置 ssh2，无 npm 依赖；若仍出现，检查是否装的是旧版本 tgz |
| profile 启动报 JSON 错误（BOM） | profile `package.json` 被带 BOM 的工具写入；用无 BOM UTF-8 重写 |
| 面板显示"插件还没激活" | host 半没加载：完全退出 DSH 再开，或确认 `-Doctor` 里 bundle=True |
| 工作区打不开（attach failed） | DSH_HOME 迁移导致旧路径；插件启动时会自愈，仍失败则用 `-Doctor` 看 stub 路径 |
| 两个插件同时存在 | 都会接管 `ctx.fs`；用 `install.ps1 -RemoveOld` 或卸载旧插件 |
| 终端退回纯文本 | xterm 资源加载失败（`/assets/*` 403/404）；检查 token 与 `vendor/xterm` 是否存在 |

## 6. 扩展指引

- **客户端插槽**：`sidebar.footer.action`（胶囊）、`sidebar.panellist` + `main`（控制台）、
  `sidebar.session.row.leading`、`sidebar.session.row.hover`、`conversation.session.header.utilities`。
- **Host 侧新增能力**：在 `lib/` 下加模块（如 terminal.js、forwards.js），在 `index.js` 组装，
  在 `lib/api.js` 加回环路由；客户端通过 `call()` 访问。
- **数据模型**：连接在 `connections.json`（含颜色/自动连接），工作区是带 `.dsh-remote.json`
  的 stub，转发在 `forwards.json`。
- **终端资源**：`vendor/xterm` 由 host 在 `/assets/*` 提供，新增资源时同步更新 `api.js` 白名单与
  `check-manifest`。
- **内置依赖**：`vendor/node_modules` 只放运行必需的最小文件；升级 ssh2 时保留其 LICENSE。

## 7. 发布与回滚

```powershell
# 安装/切换（会备份 profile package.json）
.\install.ps1 -Profile desktop -RemoveOld

# 回滚
.\install.ps1 -Rollback -Profile desktop

# 状态检查
.\install.ps1 -Doctor -Profile desktop
```

数据在 `<DSH_HOME>\remote-deck`，重装/回滚都不会删；`-Uninstall` 也只移除插件登记与文件。
