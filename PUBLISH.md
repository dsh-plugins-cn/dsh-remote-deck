# 发布与切换手册

本文件记录 Remote Deck 从仓库到用户桌面的完整步骤。**切换桌面 profile 前请先读完第 5 节。**

## 0. 当前状态

- 版本：`1.0.0`
- 仓库：本地 git 已完成（`<repo>`），等待远端地址
- 包名：`dsh-remote-deck`（npm 上未占用，发布前再确认一次）
- 测试 profile：`deckcheck`（不影响桌面）
- 桌面 profile：仍使用旧插件 `dsh-remote-ssh`，**尚未切换**

## 1. 发布前检查

一键执行（拒绝脏工作区，不推送、不发布）：

```powershell
.\scripts\release.ps1        # 校验 + 测试 + 打包
.\scripts\release.ps1 -Tag   # 再打当前版本的 tag
```

推送 tag 后，`.github/workflows/release.yml` 会自动运行 check/test 并创建 GitHub Release，
附上 `dsh-remote-deck-*.tgz`。

```powershell
npm run check          # 语法 + manifest
npm test               # ssh-config / 端口解析单测
npm run pack:dry       # 发布文件清单（不应包含 docs/、test/、scripts/）
git status --short     # 必须是干净工作区
```

同时确认：

- `CHANGELOG.md` 有对应版本条目；
- `docs/design/v2/` 有脱敏设计稿与渲染截图；
- `README.md` 的截图路径有效。

## 2. GitHub

```powershell
cd <repo>
git remote add origin https://github.com/dsh-plugins-cn/dsh-remote-deck.git
git push -u origin main
git tag -a v1.0.0 -m "Remote Deck v1.0.0"
git push origin v1.0.0
```

然后在 GitHub 建 Release（选 tag），把 `CHANGELOG.md` 对应段落粘进去；附件可选
`dist/dsh-remote-deck-1.0.0.zip`（`build.ps1` 生成，含 ssh2 依赖，可离线安装）。

推送完成后补 `package.json` 的发布元数据并提交：

```json
"repository": { "type": "git", "url": "https://github.com/dsh-plugins-cn/dsh-remote-deck.git" },
"homepage": "https://github.com/dsh-plugins-cn/dsh-remote-deck#readme",
"bugs": { "url": "https://github.com/dsh-plugins-cn/dsh-remote-deck/issues" }
```

## 3. npm

```powershell
npm whoami                     # 确认登录
npm view dsh-remote-deck        # 应为 404（未被占用）
npm publish --access public
```

发布后验证：`npm view dsh-remote-deck version` 与 `npm pack dsh-remote-deck@1.0.0 --dry-run`。

> 若名字被别人占用，改用 `@<scope>/dsh-remote-deck`，同时更新 `cordis.patch.yml` 的 `name`、
> `client.js` 的模块 id 与 README。

## 4. DSH 插件市场

市场索引由 DSH 侧维护。准备一段 100 字以内的简介 + 仓库地址 + 截图，按市场要求提交；
在此之前，用户可以直接用仓库地址安装：

```sh
dsh plugin add git+https://github.com/dsh-plugins-cn/dsh-remote-deck.git
```

## 5. 桌面 profile 切换（需用户确认后执行）

**风险说明**：两个插件都会接管 `ctx.fs`，同一个 profile 不能同时启用。切换后需要重启 DSH；
旧插件文件与 `package.json` 备份都会保留，可一键回滚。

```powershell
# 1) 备份现状（install.ps1 另外会保存 package.json.bak-before-deck）
$prof = "$env:DSH_HOME\profiles\desktop"
Copy-Item "$prof\package.json" "$prof\package.json.bak-remote-deck" -Force

# 2) 一条命令切换：安装 Remote Deck 并从该 profile 移除旧插件登记（旧文件保留）
cd <repo>
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop -RemoveOld

# 3) 完全退出 DSH 再打开（托盘退出，确认进程结束）
```

切换后验证：

1. 侧栏出现 **SSH** 胶囊与 **远程开发**；
2. 旧连接仍在，原工作区仍在侧栏；
3. 在远程工作区新建会话，`bash` 执行 `pwd` 为远端路径；
4. 终端能打开、端口页能发现监听端口；
5. 面板底部 `host 1.0.0`。

回滚：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Rollback -Profile desktop
# 再重新确认 dsh-remote-ssh 在 bundles 中，重启 DSH
```

## 6. 凭证与安全

- 推送使用已配置的 SSH key（`ssh -T git@github.com` 验证），不要用账号密码。
- token 只在当次命令中使用，不写进任何文件、不提交、不留在 shell 历史里。
- 推送完成或失败后，可在 GitHub 设置里立即撤销该 token。
- 不要在本仓库提交 `connections.json`、`secrets.json`、会话记录或任何私钥。

## 7. 发布后回归清单

- [ ] `npm run check` / `npm test` / `npm run pack:dry` 通过
- [ ] 干净 profile 安装：`dsh plugin add dsh-remote-deck` 后可用
- [ ] 迁移：旧连接/工作区/会话可见
- [ ] 远端执行：`bash`、读写、`grep`/`glob` 正确
- [ ] 终端：输入命令有输出
- [ ] 端口：发现 + 转发 + 停止
- [ ] 深色/浅色截图与 README 一致
- [ ] 回滚脚本实测可用

## 8. 插件市场（dsh.so）

- 提交入口：<https://www.dsh.so/submit>（粘贴仓库 URL，无需 GitHub 授权，服务端自动扫描）
- 2026-11-05 已提交：issue `#430`（提交响应返回；仓库 `ihuajiu/dsh-plugin-submissions`）
- 收录流程：格式校验 → 安全扫描 → 维护者合并 → 出现在 `cdn.dsh.so/market/index.json`
- 仓库有更新后，用同一入口重新提交一次（服务端会重新扫描最新 release）
- 收录后市场里会显示安装方式；国内网络也可用仓库 README 里的代理命令

## 9. 后续更新与同步

发布新版本：

```powershell
# 1) 改 package.json version 与 index.js BUILD（必须一致）
# 2) 更新 CHANGELOG
.\scripts\release.ps1 -Tag
git push origin main
git push origin v<version>
```

- GitHub Actions 自动跑 check/test 并创建 Release、附 `dsh-remote-deck-<version>.tgz`
- 本机更新：`git pull` 后 `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop`，完全退出 DSH 再打开
- 市场更新：重新走一遍第 8 节的提交入口
