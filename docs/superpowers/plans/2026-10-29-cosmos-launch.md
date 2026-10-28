# 星空主题与宇宙大爆炸开机动画实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Deep Connect 加入可访问的星空主题，并为 DSH 加入可跳过、可关闭、可重播的宇宙大爆炸启动动画。

**Architecture:** 在 Deep Connect 既有客户端内叠加星空装饰，不触碰业务状态。新建独立 `dsh-cosmos-launch` 插件，通过 `shell.overlay` 渲染一次性启动层，`settings.section` 提供重播与开关；纯函数管理动画阶段与确定性星点。

**Tech Stack:** 原生 JavaScript、DSH Cordis Client slots、CSS 动画、Node 内置测试。

**Spec:** `docs/superpowers/specs/2026-10-29-cosmos-launch-design.md`

## Global Constraints

- 不修改 DSH 应用本体、根组件或 Electron 二进制启动流程。
- 不引入新第三方依赖，不在画布或每帧计时器中重建大量对象。
- 连接状态和任务内容不得被装饰遮挡或伪造。
- 支持 `prefers-reduced-motion`，并清理插件计时器和监听器。
- 每个新行为先写失败测试，再实现。

## Review Focus

- 动画设置持久化、跳过与重播互不冲突。
- 减弱动态效果下没有持续漂移或爆发运动。
- 启动层退出后完全移除，不能遮挡后续使用。
- 星空装饰不遮挡面板交互，也不被误认为连接状态。
- 缺少浏览器存储时不抛错，仍能跳过。

---

### Task 1: Deep Connect 星空主题

**Files:**
- Modify: `deep-connect/tools/client-check.mjs`
- Modify: `deep-connect/plugin/client.js`

**Interfaces:**
- Consumes: 现有 `PanelBody`、主题 token 和既有业务状态。
- Produces: 带 `data-dc="cosmos"` 的非交互装饰层与 `dc_cosmos*` CSS。

- [ ] **Step 1: Write the failing test**

在客户端测试中要求面板存在 `data-dc="cosmos"` 装饰，具有 `aria-hidden="true"`、星空/行星标识和减弱动态效果 CSS，且容器不拦截点击。

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/client-check.mjs`

Expected: 星空标识不存在导致测试失败。

- [ ] **Step 3: Implement minimal cosmos decoration**

在面板根部插入轻量星空、轨道行星和星云装饰；背景保持在内容下层，所有装饰 `pointer-events:none`，补充行星轨道与呼吸动画及 reduced-motion 静态降级。

- [ ] **Step 4: Run tests**

Run: `node tools/client-check.mjs && node tools/deep-connect-e2e.mjs && node tools/relay-smoke.mjs && node tools/station-smoke.mjs`

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add plugin/client.js tools/client-check.mjs
git commit -m "feat: add cosmic theme to Deep Connect"
```

### Task 2: Cosmos animation state and tests

**Files:**
- Create: `dsh-cosmos-launch/cosmos.js`
- Create: `dsh-cosmos-launch/test/cosmos.test.mjs`

**Interfaces:**
- Produces: `createStars(seed,count)`, `launchPhase(elapsed,options)`, `shouldShowLaunch(settings)`, `safeStorage(backend)`.

- [ ] **Step 1: Write failing tests**

验证同一 seed 的星点一致、不同 seed 不同；正常动画依次进入 burst、expansion、orbit、finished；减弱动态效果只短暂显示后结束；跳过或关闭后不显示，重播能再次显示；存储失败回退内存且不抛错。

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/cosmos.test.mjs`

Expected: 模块不存在或行为未实现导致失败。

- [ ] **Step 3: Implement pure state helpers**

只写满足断言的确定性星点生成、阶段计算、启动条件和安全存储；不做真实 DOM 操作。

- [ ] **Step 4: Run tests to verify passing**

Run: `node --test test/cosmos.test.mjs`

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add cosmos.js test/cosmos.test.mjs
git commit -m "feat: define deterministic cosmos launch state"
```

### Task 3: Installable launch overlay and settings

**Files:**
- Create: `dsh-cosmos-launch/package.json`
- Create: `dsh-cosmos-launch/cordis.patch.yml`
- Create: `dsh-cosmos-launch/index.js`
- Create: `dsh-cosmos-launch/client.js`
- Create: `dsh-cosmos-launch/icon.svg`
- Create: `dsh-cosmos-launch/locale/zh.json`
- Create: `dsh-cosmos-launch/locale/en.json`
- Modify: `dsh-cosmos-launch/test/cosmos.test.mjs`

**Interfaces:**
- Consumes: Task 2 helpers and inspected `shell.overlay` / `settings.section` slots.
- Produces: DSH 启动覆盖层和“开机动画”设置页。

- [ ] **Step 1: Add failing lifecycle test**

模拟插件 apply，验证可跳过、可重播、退出覆盖层、定时器清理，以及没有浏览器存储时不抛错。

- [ ] **Step 2: Verify failure and implement package**

先运行测试确认失败，再实现 Overlay/设置注册、文案、原创图标、插件清单与生命周期清理。所有文本通过 locale 服务显示，不修改 DSH 根节点。

- [ ] **Step 3: Run tests and syntax checks**

Run: `node --test test/cosmos.test.mjs && node --check client.js && node --check index.js`

Expected: 全部通过，无控制台错误。

- [ ] **Step 4: Install and inspect live registration**

Run `plugin_manager install_bundle` for the workspace bundle, then `cordis_inspect_query` for `shell.overlay` and `settings.section`. Verify package metadata, icon resource and registered entries.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: add skippable Big Bang launch overlay"
```

### Task 4: Release and verification

**Files:**
- Modify: `deep-connect/plugin/package.json`
- Modify: `deep-connect/plugin/host/version.js`
- Modify: `deep-connect/README.md`

- [ ] **Step 1: Run all tests and inspect diffs**

Expected: Deep Connect 四套测试及 cosmos 测试全部通过，diff 仅包含目标改动。

- [ ] **Step 2: Bump version, document, install locally**

升级到 Deep Connect v4.3.0，发布 tag；确认本机安装版本与主题代码。使用 `plugin_manager` 安装启动插件，不用手改 profile。

- [ ] **Step 3: Verify release and report limits**

验证 jsDelivr 可下载；记录启动覆盖层真实注册结果与浏览器可见性验证限制。

- [ ] **Step 4: Commit and push**

```bash
git add README.md plugin/package.json plugin/host/version.js
git commit -m "release: v4.3.0 cosmic theme and Big Bang launch"
git push origin main
```
