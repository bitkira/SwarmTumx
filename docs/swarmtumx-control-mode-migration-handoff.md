# SwarmTumx Control Mode 迁移交接文档

这份文档是给下一位 AI 的执行说明。

目标不是继续在 `tmux attach-session -> xterm.js` 这条链上打补丁，而是按最佳实践，把 **tmux 保留为会话/Pane 管理层**，把 **xterm.js 保留为唯一显示层/唯一滚动拥有者**，逐步迁移到 **tmux control mode 驱动** 的终端前端。

## 1. 先说结论

当前滚动/缩放问题的根因，不是单纯的 CSS，也不是单纯的 wheel 事件，而是当前架构：

- 前端显示层：`xterm.js`
- 终端桥接层：`node-pty`
- 后端会话层：`tmux attach-session`

这会导致 `tmux` 作为一个真实 client 去接管外层屏幕语义。

在真实 `tmux attach-session` + resize 回流里，`xterm` 会进入不稳定的备用屏/重绘状态，表现为：

- 滚动到顶部时会突然跳回底部
- 终端内容一旦被放大到“正好全显示”，再缩小后，滚动条可能消失
- 此时继续滚轮，体验像是在滚 `tmux` 自己那一层历史，而不是 `xterm` 的 scrollback

已经确认过：

- **纯 xterm.js 前端** 单独测试时，放大再缩小，滚动能力是正常的
- **把真实 tmux attach / resize 的控制序列喂给 xterm.js** 时，xterm 会出现 scrollback 塌缩
- 典型状态表现为：
  - `activeType = alternate`
  - `baseY = 0`
  - `length = rows`

翻成人话就是：**xterm 以为自己只剩当前这一屏，没有历史可滚了。**

## 2. 下一位 AI 的总目标

下一位 AI 的目标不是“修一个滚轮 bug”，而是：

1. 保留 `xterm.js`
2. 不再让 `xterm.js` 直接吃 `tmux attach-session` 的全屏输出
3. 把终端接入改为 **tmux control mode / 结构化事件驱动**
4. 让 `xterm.js` 成为唯一显示层、唯一 scrollback owner
5. 在不破坏现有通信功能的前提下完成迁移

## 3. 绝对不能破坏的功能边界

本次迁移的重点是 **终端传输层 / 显示层**，不是业务协议重写。

以下能力必须保持行为不变：

- agent 身份、登录、登出、runtime binding
- relation request / accept / decline / remove
- `send_message`
- `read_inbox`
- `read_messages`
- `search_messages`
- broker 唤醒机制
- 通知语义
- 关系接受与 inbox 通知的区分
- self-authored reply 不应计入 unread

尤其是通信相关代码，必须视为高敏感区域：

- `src/runtime/agent-service.js`
- `src/runtime/agent-broker.js`
- `src/runtime/agent-db.js`
- `docs/swarmtumx-agent-inbox-broker-design.md`
- `docs/swarmtumx-agent-notification-rules.md`

除非迁移必须，否则不要改这些业务语义。

原则：

- **优先保持现有 renderer / preload / service API 形状不变**
- **优先替换 transport adapter，不替换业务模型**

## 4. 当前关键代码入口

下一位 AI 应先从这里入手：

- 当前 tmux attach 路径：`src/runtime/tmux-terminal-manager.js:62`
- 当前 `attach-session` 调用点：`src/main/main.js:109`
- 当前前端 xterm 初始化：`src/renderer/app.js:487`
- 当前 resize 回调：`src/renderer/app.js:554`
- 当前 tmux 默认配置：`tmux.conf:1`

请先理解当前调用链：

1. renderer 创建 xterm
2. renderer 调 `terminal:attach-session`
3. main 交给 `TmuxTerminalManager`
4. `TmuxTerminalManager` 用 `node-pty` 启一个真实 `tmux attach-session`
5. xterm 接收的是 tmux client 的整屏输出

最佳实践迁移后，应变成：

1. renderer 继续用 xterm
2. renderer 继续使用稳定的 `attach/write/resize/onData` 风格 API
3. 但 backend 不再启动 `tmux attach-session`
4. backend 改成维护一个 tmux control mode client
5. backend 把结构化 pane/session 事件翻译成前端可消费的数据流

## 5. 推荐迁移策略

不要一次性硬切。

推荐分阶段进行：

### 阶段 A：建立新 transport，不动业务层

新增一个 control mode 版的 terminal manager，例如：

- `ControlModeTerminalManager`

要求：

- 不要先删旧的 `TmuxTerminalManager`
- 用 feature flag 或显式配置切换新旧实现
- 尽量保持 renderer 侧 API 不变

例如可以保留这类契约：

- `terminal:attach-session`
- `terminal:detach-session`
- `terminal:resize-session`
- `terminal:write`
- `terminal:onData`
- `terminal:onExit`

### 阶段 B：先保证普通 shell 输出 + resize + scrollback 正常

在切入 agent/通信场景之前，先保证：

- 普通 shell 输出正常
- grow -> shrink 后 scrollback 仍在
- 滚到顶部不会突然跳回底部
- 当内容一度正好铺满视口后，缩小回来仍能滚

### 阶段 C：再验证 agent 和通信链路

普通 shell 稳定后，再回归：

- login / logout
- relation request / accept
- send_message
- read_inbox
- broker wake
- relation accepted status notification

### 阶段 D：最后才考虑移除旧 attach 路径

只有在新路径通过全部测试并且人工验证稳定后，才允许考虑移除旧实现。

## 6. 明确的实现原则

下一位 AI 在实现时必须遵守：

### 6.1 一个 tile 只能有一个 scroll owner

这个 owner 必须是 `xterm.js`。

不要再让：

- tmux attach client
- 应用层自定义 wheel
- 其他外层容器

共同控制终端滚动。

### 6.2 resize 只能走一条链

推荐链路：

1. DOM 尺寸变化
2. xterm fit
3. 后端同步 pane/session 尺寸
4. 后端返回必要状态
5. xterm 保持自己的 scrollback

不要再让 resize 依赖 tmux 整屏重绘来“重新定义可见屏幕”。

### 6.3 不要先碰 agent 通信语义

这是终端架构迁移，不是 inbox / broker / notification 重写。

如果通信功能出问题，说明改动范围已经越界了。

### 6.4 先保证 packaged-runtime 行为

根据仓库已有约定，涉及 `tmux` 终端行为前，必须先重启本地 `swarmtumx` tmux server：

- `tmux -L swarmtumx kill-server || true`

不要只在长生命周期 dev session 上观察结果。

## 7. 必须通过的测试与验收

下一位 AI 在提交前，至少要完成以下验证。

### 7.1 自动测试

现有测试必须保持通过：

- `npm test`

重点观察：

- `test/agent-broker-tmux.test.js`
- `test/agent-service.test.js`
- `test/agent-cli-tmux.test.js`
- `test/tmux-adapter-session-exists.test.js`

如果为了新 transport 增加测试，优先补：

- grow -> shrink 后 scrollback 不丢
- 内容曾完整铺满后再缩小，scrollbar 仍可恢复
- 顶部滚动不会跳回底部
- 普通 shell 输出与 agent CLI 仍然可用

### 7.2 人工验证

必须手动验证：

1. 启动应用
2. 终端内输出足够多的内容
3. 鼠标滚轮可滚动当前 terminal scrollback
4. 拉到顶部后不会突然弹回底部
5. 把 tile 或窗口放大到可完整显示所有内容
6. 再缩小回来后，滚动条仍然存在，且 scrollback 正常
7. agent 通信仍然正常

### 7.3 通信专项回归

必须验证至少一条完整链路：

1. A 登录
2. B 登录
3. A 请求关系
4. B 接受关系
5. A 收到 relation accepted 状态通知
6. A 给 B 发消息
7. B 收到 inbox wake
8. B `read_inbox`
9. B `read_messages`
10. B 回复

要求：

- 不得重新引入“空 inbox 提示”
- 不得重新把 self-authored reply 算成 unread
- 不得改变 `[SWARMTUMX_NOTIFY]` 语义

## 8. Logo 任务（交给下一位 AI）

下一位 AI 还需要完成一个单独任务：

- 使用仓库根目录的 `honeycomb-svgrepo-com.svg`
- 输出一个新的 PNG 作为软件 logo 源图
- 再把这个新 PNG 接入软件图标流程

注意：

- 这是新的 logo 任务，不是继续沿用当前 `swarm.png`
- 但在新 logo 全部接线完成前，不要贸然删除现有图标链路
- 先产出 PNG，再更新 icon 生成流程，再验证打包

推荐步骤：

1. 用 `honeycomb-svgrepo-com.svg` 生成高分辨率 PNG
2. 让新的 PNG 成为 mac 图标源图
3. 更新 dev mode dock icon 与 packaged app icon
4. 重新验证：
   - `npm run icon:mac`
   - `npm run dist:mac`
5. 确认产物里 `icon.icns` 对应的是新 logo

## 9. 提交要求

下一位 AI 完成本次迁移后，应：

1. 跑完自动测试
2. 做完人工验证
3. 确认通信功能无回归
4. 再 commit
5. push 到 `main`

不要在“滚动看起来差不多”但通信未回归验证时就提交。

## 10. 最后的执行提醒

这次任务的关键词不是“修 wheel”，而是：

- 保留 `xterm.js`
- 去掉 `attach-session` 作为显示主链路
- 引入 control mode / 结构化 tmux adapter
- 把 scrollback 所有权明确交给 `xterm.js`
- 不影响现有 agent 通信能力

如果下一位 AI 想直接在旧链路上继续补丁：

- 这不是这份文档要求的方向
- 那样大概率只能止血，不能根治

