# 04 · 侧边栏 / 会话列表 / 布局 / 主题 拆解

> **来源（只读）**：`C:\Users\20247\Downloads\oss-study\deepseek-harness\packages\client\`
> 下文所有 `client/…` 都是该目录的相对路径；行号是本次阅读时的行号。
> **移动端现状（只读参考）**：`C:\Users\20247\Downloads\aiwork\dsh-native-mobile\`
> 会话列表相关文件正被并行改动，移动端行号以本文写作时的快照为准（见 §1.7 注）。
> 本文只做拆解，没有修改任何桌面源码。

---

## 0. 一页速览

| 主题 | 桌面版做法 | 移动端现状 | 结论 |
| --- | --- | --- | --- |
| 侧边栏骨架 | 单列 shell：品牌行 / 新建 / 全局面板行 / 工作区浏览区 / 底部设置（`SidebarRoot.tsx`） | 抽屉（`AppDrawer.tsx`）+ 独立路由页 `sessions` | 分组浏览下沉到 `sessions` 路由，方向一致；骨架语义不同 |
| 会话分组 | 按 **Workspace 实体** 分组，三种模式（workspace / workspace-tree / flat） | 按 **cwd 字符串** 分组，单模式 | 语义差一层（见 §1.2、§1.7） |
| 排序 | 分区（blank → pinned → 普通）+ 组内 `updated` / `manual` | 组内「运行中优先 + updatedAt 倒序」 | 移动端少了 pin / manual |
| 折叠持久化 | `dsh.workspace.view.v5` 一整个 blob | `dsh.sessions.collapsed.v1` | key 命名可对齐，见 §1.6 |
| 归档 | **Host 归档**（`workspace/archiveSession` RPC + 三态过滤） | 仅本机归档 + 底部归档区 | 移动端是降级版，文案必须写明（已写明） |
| 多面板 | 右栏 = 每会话一个 dock 面板，tab 化 + 可分屏 + 可浮窗 | 无 | 建议只做「单面板 + tab 条」，砍掉分屏/浮窗 |
| 断点 | 1024（左栏自动折叠）、768（右栏自动全屏） | 无断点，手机优先 | 见 §3 |
| 窄屏退化 | **退化成 56px 图标 rail，不是抽屉**（手动展开是挤压中心，无遮罩） | 真抽屉（遮罩 + 320px 侧滑） | 移动端现有做法更适合触摸，保留 |
| 主题 | `body[data-ds-dark-theme]` + 190 个 CSS 变量三层 token | 只有深色，15 个变量 + 约 531 处硬编码 hex（快照） | **本文 §4 的 token 表就是浅色主题的施工依据** |

---

## 1. 侧边栏结构

### 1.1 骨架（谁拥有哪一段）

`client/ui-sidebar/src/client/SidebarRoot.tsx` 是整个左列的壳，模块注释（`:1-18`）明确划了边界：

| 区段 | 拥有者 | 位置 |
| --- | --- | --- |
| 列几何（宽度、collapse 滑动 + 交叉淡入） | ui-sidebar shell（受 ui-layout 网格驱动） | `SidebarRoot.tsx:106-127`、`206-212` |
| 品牌行（macOS 顶条 / logo 行） | shell | `SidebarRoot.tsx:213-256` |
| 新建会话 | shell | `SidebarRoot.tsx:259-277` |
| 全局面板行（不是右栏面板，见 §2） | shell，数据来自各插件注册 | `SidebarRoot.tsx:279-293` |
| **工作区 / 会话浏览区**（分组、搜索、会话行、工作区对话框） | `sidebar.workspaces` 洞 → **ui-workspace** | `SidebarRoot.tsx:297-302`；`client/ui-sidebar/src/client/contract/slots.ts:36-42` |
| 底部：设置 + 可选 footer actions | `sidebar.settings` / `sidebar.footer.action` 洞 | `SidebarRoot.tsx:304-312` |

- 折叠是「内容冻结在原宽淡出 + 列网格收缩裁剪」，150ms 后卸载 wide 内容并显示 rail 图标（`SidebarRoot.tsx:31`、`:104-113`、`:1-12`）。
- rail 状态是 **36×36 控件居中在 56px 列里（左右各 10px 内边距、12px 纵向节奏）**（`SidebarRoot.module.css:31-36` 的 rail spec 注释 + `.root.collapsed{padding:18px 10px 6px}`；56px 轨道宽见 `client/ui-layout/src/client/columns.ts:19`）。
- 滚动条随指针：指针离开列 2000ms 后才隐藏滚动条（`SidebarRoot.tsx:33-39`、`:129-170`），这是一处纯 hover 语义，触摸端必须换掉（见 §5）。

### 1.2 会话列表怎么组织

**分组依据是 Workspace 实体，不是 cwd 字符串。** 这是桌面与移动端最大的语义差异。

| 事实 | 证据 |
| --- | --- |
| 三种分组模式：`'workspace' \| 'workspace-tree' \| 'flat'` | `client/ui-workspace/src/client/stores.ts:17` |
| 默认 `'workspace'`（兄弟工作区分节）；默认排序 `'updated'` | `stores.ts:85-86` |
| 分组遍历 Host 的 Workspace 列表，用 `workspace.sessionIds` 取成员 | `client/ui-workspace/src/client/tree.ts:334-360` |
| 不在任何 Workspace 的会话落到 `UNGROUPED_KEY = ''`（「未分组」桶，排在最后） | `tree.ts:17-18`、`:361-374` |
| 组标签 = Workspace 标题（可重命名）；只有标题为空时才用本地化的「默认工作区」兜底 | `client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:937-944` |
| 组顺序 = Host 侧 Workspace group order（拖拽工作区行是可持久化的 Host 顺序） | `README.md:44`（"Workspace group drag order remains Host-durable"） |
| `workspace-tree` 模式：按「最近注册祖先目录」嵌套（`owningParentFolder`，大小写敏感、不做软链解析） | `tree.ts:636-648`；`WorkspaceBrowser.tsx:354-362`、`:1451` |
| 树模式下子工作区排在父工作区自己的会话之前；祖先默认展开（除非有保存的折叠态）；搜索跳转会把所有祖先展开 | `README.md:44` |
| cwd 只用于：hover card 显示与复制、以及没有 Workspace 标题时的退路名（basename） | `tree.ts:131-135`；`rows/Rows.tsx:161-174`、`:313-329` |

**子代理会话在侧边栏里根本不出现**：`session.origin === 'subagent'` 直接被过滤（`tree.ts:244`），只在父会话行上显示「N 个子代理运行中」（`tree.ts:390-395`；`rows/Rows.tsx:352-362`）。移动端目前把子代理收进组内「子代理 (N)」子节，是**更宽松**的做法，对齐时需要决定保留（建议保留，移动端没有父行密度）。

### 1.3 排序

两级：先分区，再组内顺序。

| 层级 | 规则 | 证据 |
| --- | --- | --- |
| 分区（组内） | 选中的 blank「新会话」占位 → pinned（未归档）→ 其余 | `tree.ts:273-287`（`sectionMembers`） |
| 组内 `updated` | `updatedAt` 倒序，相等时 `sessionId` 升序（确定性 tie-break） | `tree.ts:143-157` |
| 组内 `manual` | pins（按 pin 数组顺序）→ 保存的相对顺序 → 普通成员按 recency → **archives 最后** | `tree.ts:168-209` |
| manual 里的 fork | 新的普通 fork 插到它的源之前，不继承 pin | `tree.ts:199-207` |
| 选中的 blank | 永远第一个，且不可拖拽 | `tree.ts:217-223`；`README.md:40` |
| 「最近更新」的真实语义 | **最后一次用户 prompt / steer 的时间**，不是任意 updatedAt；pin 时间不影响 | `README.md:36` |

⚠️ 移动端 `compareSessions` 现在是「running 优先 → updatedAt 倒序 → sessionId 升序」（`src/lib/session-groups.ts:185-196`）。桌面**没有 running 优先**这一层，running 只影响状态点与「显示更多」的水位。这是有意的移动端增强，建议保留，但要在文档/代码注释里标注为「移动端差异」，避免以后有人以为是不一致。

### 1.4 每项显示哪些字段

| 行类型 | 常显 | hover / 长按才出现 | 证据 |
| --- | --- | --- | --- |
| 工作区行 | 文件夹开/关图标、**折叠箭头只在 hover 时出现**、标题 | `…` 菜单（重命名 / 删除）、「新建会话」按钮、800ms 后 hover 卡（标题 / 完整 cwd / 创建时间 / 复制 cwd） | `rows/Rows.tsx:219-330`（图标 `:259-261`、箭头 `:262-264`、菜单 `:268-296`、新建 `:297-307`、卡 `:313-329`） |
| 会话行 | 16px 状态槽、标题、尾部「相对时间」或 pending 紧凑标签（`审批`/`计划`/`回答`）、pin 标记 | hover 时标题 marquee 滚动到末尾、双击标题重命名、`…` 菜单 + hover 动作按钮、800ms hover 卡（完整标题、相对时间、计划任务、状态行、归档说明） | `rows/Rows.tsx:545-705`（状态槽 `:632-636`、marquee `:102-134`、双击 `:640-642`、尾部 `:650-657`、pin `:660`、菜单 `:664-690`、卡 `:427-458`） |
| 搜索结果行 | 状态点、标题、工作区标签、内容片段（snippet）；归档行带「恢复」按钮 | 无 hover 卡 | `rows/Rows.tsx:472-523` |

状态点的优先级（决定那 16px 槽里画什么）：`pendingInteraction`（approval / plan-review / question）> 自身 running > 子代理运行数 > 未读完成 → 否则 idle；idle 时才把槽让给 `sidebar.session.row.leading` 洞（例如计划任务时钟标记），归档行整槽留空（`rows/Rows.tsx:344-398`、`:627-636`；`README.md:66`、`:70`）。

状态点的枚举与配色走 token：`StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'`（`client/ui-primitives/src/StateDot.tsx:9`），颜色分别是 `--dsw-alias-state-success-primary` / `state-warn-primary` / `label-tertiary`（spinner）/ `state-error-primary` / `state-idle-primary`（`client/ui-primitives/src/StateDot.module.css:17-40`）。

### 1.5 筛选与搜索

| 能力 | 行为 | 证据 |
| --- | --- | --- |
| 归档三态 | `ArchivedFilter = 'default'（隐藏，默认）\| 'show'（灰显就地混排）\| 'only'（只看归档）`；`only` 会丢掉没有归档的组 | `tree.ts:230`、`:238-257`、`:353-355` |
| 归档行的行为 | 可见但灰显、**不可打开**（点击给解释），仍可重命名 / fork / 恢复 | `WorkspaceBrowser.tsx:961-967`；`rows/Rows.tsx:484-513`；`README.md:58` |
| 视图选项菜单 | 一个菜单三组：Group by（工作区 / 工作区树 / 单列表）、Order by（手动 / 最近更新）、Filter by（隐藏归档 / 全部会话 / 只看归档） | `WorkspaceBrowser.tsx:142-204`（菜单项 `:157-175`） |
| 搜索入口 | 头部一个按钮，点开才把输入框展开占满 header；`Esc` 清空并收起 | `WorkspaceBrowser.tsx:1274-1330`、`:1308-1313` |
| 本地即时匹配 | 大小写不敏感的**标题 + 工作区标签**子串匹配，按 recency 排序 | `tree.ts:570-584` |
| 远端内容搜索 | 250ms 防抖（`SEARCH_DEBOUNCE_MS = 250`），每次新查询 abort 上一个请求 | `WorkspaceBrowser.tsx:51`、`:1152-1187` |
| 合并策略 | 本地命中在前；远端内容命中按后端顺序追加；重复 id 就地补上 snippet，不重复占行；`limit` 截断 → `hasMore` 提示 | `tree.ts:542-621`；`WorkspaceBrowser.tsx:880-884` |
| 搜索上限 | 查询串 500 UTF-16 code unit（`maxLength` 同步），结果 20 条 | `WorkspaceBrowser.tsx:53`、`:109-117`、`:1304`；`README.md:50` |
| 空会话不参与匹配 | blank 行的显示名是本地化的「新会话」，匹配它会绑定语言，所以排除 | `tree.ts:295-297`、`:572-575` |
| 搜索失败降级 | 保留本地元数据命中，不加额外告警 | `README.md:50` |
| 搜到之后 | 清空并收起搜索 → 打开会话 → 滚动到该行 → 展开所在工作区（树模式展开全部祖先） | `README.md:50`；`WorkspaceBrowser.tsx:1091-1100`（`openSearchResult`）、`:382-388`（把 reveal 目标及其祖先置为展开）、`rows/Rows.tsx:581-585`（行滚入视野） |

### 1.6 折叠状态存在哪

| 状态 | 存储 | 证据 |
| --- | --- | --- |
| 分组模式、排序模式、**每个组的展开态**、每个 account 的手动顺序、归档过滤 | 一个持久化 blob：`persist: 'dsh.workspace.view.v5'` | `client/ui-workspace/src/client/stores.ts:91`（键名在 `:22-31` 声明字段） |
| 展开态只保留当前存在的 account key（工作区 id + `''` + 单列表 account） | `retainAccountKeys` | `stores.ts:100-109` |
| 「每组默认显示 5 条 + 显示更多」的水位 | **不持久化**，组件卸载即重置 | `README.md:30`；`WorkspaceBrowser.tsx:54-56`、`:60-71`、`:337-341` |
| 右栏布局（tab、分屏、浮窗、展开、模式） | 另一套：`dsh.sidebar-right.v1.<sessionId>`（zod 校验 + 引用完整性校验，坏数据会被清掉） | `client/ui-sidebar-right/src/client/persistence.ts:7`、`:63-91` |
| 左栏宽度、`narrowExpanded` | **不持久化**（内存 store，无 persist）；宽度偏好随刷新回到默认 280 | `client/ui-layout/src/client/stores.ts:78-92`（无 `persist`） |

移动端对齐建议：把 `dsh.sessions.collapsed.v1` 收敛成**一个** `dsh.sessions.view.v1` blob（分组模式 / 排序 / 各组展开 / 归档过滤），并沿用桌面的「版本号在 key 里、旧版本自然作废」习惯。

### 1.7 移动端现状对照

| 维度 | 桌面 | 移动端（写作时快照） |
| --- | --- | --- |
| 分组 key | Workspace 实体 id（标题可重命名，cwd 只作副标题） | 归一化 cwd 字符串（`src/lib/session-groups.ts:113-137`），空 cwd → `::unknown-workspace::`（`:32-33`） |
| 模式 | 3 种（工作区 / 工作区树 / 单列表） | 1 种（工作区分组）+ 组内「子代理」子节 |
| 组内排序 | blank → pinned → 普通；updated / manual | running 优先 → updatedAt 倒序 → sessionId（`session-groups.ts:185-196`） |
| 展开态默认 | 祖先默认展开、有保存值则以保存值为准 | 只有「含最新会话的组」默认展开，其余折叠（`session-groups.ts:359-373`） |
| 归档 | Host 归档 + 三态过滤 | 仅本机归档 + 底部「已归档 (N)」区（`session-groups.ts:29`、`:39`） |
| 搜索 | 本地即时 + 250ms 防抖远端 + 合并去重 + 20 条上限 | 本地即时（`session-groups.ts:513-529`）+ 250ms 防抖远端，远端结果单独成组（`SessionsScreen.tsx` 内 `searchResults` 通道） |
| 折叠实现 | 各包自绘（`aria-expanded` 等散落） | 统一 `CollapsibleSection`，`aria-expanded` / `aria-controls` / `useId`（`src/components/sessions/CollapsibleSection.tsx:64-73`、`:103`） |
| 每组条数上限 | 默认 5 条 + 显示更多（水位，可涨到 50 自动） | `DEFAULT_GROUP_LIMIT = 12` + 收起（`session-groups.ts:532-534`、`:568-596`） |

> 注：移动端 `src/components/sessions/` 与 `src/lib/session-groups.ts` 正在被并行开发，行号可能已漂移；上表以函数名/常量名为准更稳。

---

## 2. 多面板

### 2.1 先分清两个"面板"

1. **左栏的「全局面板行」**（`sidebar.panellist`）：每个注册了 keyed `main` 槽条目的插件一行，点它把主区从会话切换到该面板（设置、插件管理、任务管理等）。shell 只画按钮，标题来自注册元数据（`client/ui-sidebar/src/client/contract/slots.ts:31-35`、`:70-85`；`SidebarRoot.tsx:279-293`；主区派发在 `client/ui-layout/src/client/AppFrame.tsx:40-43`、`:246-248`；`activePanelId` 状态在 `client/ui-layout/src/client/stores.ts:94-101`）。
2. **右栏（right sidebar）**：会话内容的多面板区，本文重点。它是**每个会话一个 docking surface**，不是全局一组面板（`client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx:17-27`，按 `sessionId` 渲染并隐藏非当前会话的子树）。

### 2.2 右栏可打开的面板（= tab 类型）

右栏本身没有"文件面板/终端面板"的独立开关，它们都是同一个 dock 面板里的 **tab 类型（kind）**：

| kind | 归属包 | 打开方式 | 特点 |
| --- | --- | --- | --- |
| `files` | ui-sidebar-files | 空白页（guide）里的「工作区文件」入口，order 10；文件树再通过 `tabActions.openResource` 打开具体文件 | 类型本身是「页面」不是「查看器」，不声明地址（`client/ui-sidebar-files/src/client/definition.tsx:15`、`:26-39`） |
| `terminal` | ui-sidebar-terminal | `terminal.new` 命令 / guide order 20 | `multiple: true`（可开多个终端）；字号走 `--dsh-terminal-font-size`（`client/ui-sidebar-terminal/src/client/index.ts:55`、`:72-73`） |
| `browser` | ui-sidebar-browser | guide order 30 | `multiple: true`；Electron 下用 webview，Web 下 iframe（`client/ui-sidebar-browser/src/client/definition.tsx:9`、`:15-26`；实现见同包 `browser/`） |
| `text` | ui-sidebar-documentpreview | 声明地址模式 `dsh-resource://file/**`，`priority: 'fallback'` | 「兜底查看器」：任何更专门的类型都能盖过它；文本 / Markdown / 图片 / PDF / Excel / Office / HTML 都是这个类型的 body 家族（`client/ui-sidebar-documentpreview/src/client/definition.ts:15`、`:45-55`） |
| `changes-review` | ui-deliverables | 声明 `dsh-resource://changes-review/**`，`priority: 'builtin'` | 某个 turn 的改动文件对比（`client/ui-deliverables/src/client/review-definition.ts:15`、`:38-45`） |
| `guide` | ui-sidebar-right 自带 | 面板打开时的空白引导页；每个 pane 最多一个 | `GUIDE_KIND = 'guide'`（`client/ui-sidebar-right/src/client/contract/seed.ts:36`；`shell/SidebarRight.tsx:150-152`、`:324`） |

### 2.3 怎么停靠与切换

| 行为 | 机制 | 证据 |
| --- | --- | --- |
| 呈现模式 | `DockMode = 'push'（占列、推挤中心）\| 'fullscreen'（铺满 viewport）` | `client/ui-dockkit/src/contract/types.ts:38-47`；实现由嵌入方读 `mode` 自己摆位置（`SidebarRight.tsx:302-343`） |
| 折叠 | 折叠后内容**仍挂载**、平移到右边缘外，所以开/关都是同一次滑动，状态不丢 | `SidebarRight.tsx:9-14`、`:307-317` |
| 窄屏自动全屏 | `viewportWidth < 768` → 强制全屏，但**不修改用户手动记录的模式** | `SidebarRight.tsx:360-361`、`:367`；`stores.ts` 的 `reportAutoFullscreen` 语义见 `SidebarRight.tsx:86-94` |
| 面板自己的头部 | **没有**。两个控件（全屏/退出全屏、折叠）挂在 dockkit 的 chrome 座上，位于右上 pane 的 tab 条末端 | `SidebarRight.tsx:16-20`、`:263-296`、`:334-337` |
| 折叠后的入口 | 会话 header 右上角一个按钮（占用会话自己的 corner 座），面板展开时该按钮不渲染 | `client/ui-sidebar-right/src/client/shell/ExpandButton.tsx:33-52` |
| 分屏 | 同一个 docked pane 可再分一个（最多 2 个 pane，`canSplit && dockPaneIds().length < 2`），最小 pane 比例 0.2 | `SidebarRight.tsx:319-325`；模型见 `ui-dockkit/src/contract/types.ts:57-66`、`:137-192` |
| 拖拽 tab | 5 个投放区 `DockZone = center/top/right/bottom/left`；可跨 pane 移动、重排、拖出成浮窗、拖回停靠 | `ui-dockkit/src/contract/types.ts:35-36`、`:154-167` |
| 浮窗 | 浮窗不是另一个概念，就是 `host: 'float'` 的 pane，容量 1 个 tab，可移动/缩放 | `ui-dockkit/src/contract/types.ts:68-81`、`:168-171` |
| 快捷键 | 右栏开关 `Mod+Alt+B`（Web `Mod+Shift+B`）；分屏 `Mod+\`；全屏 `Mod+Alt+Enter`；关页 `Mod+W`；刷新 `Mod+R` | `client/ui-sidebar-right/src/client/shortcuts.ts:28-96` |
| 每个会话独立 | tab / 分屏 / 浮窗 / 展开态按会话存储；切走再切回，右栏状态还原 | `RightbarRoot.tsx:17-27`；`persistence.ts:63-91` |

### 2.4 移动端要不要对应物

| 桌面能力 | 移动端建议 | 理由 |
| --- | --- | --- |
| 单个右栏面板（tab 化） | **要**：全屏二级页 + 顶部一条可横滑的 tab 条；底部小尺寸时用底部 sheet（半屏）承载文件树 | 这是「看文件 / 看终端 / 看预览」的唯一载体，缺了就只能来回跳会话 |
| 多个 tab + 关闭/切换 | **要**，但砍掉拖拽排序 | 触摸排序收益低、误触高 |
| push / fullscreen 双模式 | **不要**：手机只有全屏一种 | 屏幕宽度不支持并排 |
| 分屏（2 pane） | **不要** | 手机上两侧都不可读；桌面自己都限制到 2 个 |
| 浮窗 | **不要** | 触摸下与 sheet 重叠，语义混乱 |
| 拖拽 tab 跨 pane | **不要** | 换成「长按 tab → 菜单：关闭 / 在新页打开」 |
| `ExpandButton`（会话 header 角落入口） | **要**：会话页右上角一个入口按钮即可，与桌面语义一致 | 低成本、用户认知一致 |
| kind 集合 | 首期只做 `files`（只读文件树）+ `text`（预览）| 终端与内置浏览器在 WebView/Android 上是独立工程（需要 xterm.js / webview 权限），不要混在 UI 对齐里做 |

---

## 3. 布局与响应式

### 3.1 三列网格与常量

`client/ui-layout/src/client/AppFrame.tsx:258-274` 渲染一个 grid：`sidebar | center | rightbar`，列宽由 `columns.ts` 求解。

| 常量 | 值 | 含义 | 定义 |
| --- | --- | --- | --- |
| `CENTER_MIN` | 400 | 右栏打开时保护的中心最小宽 | `client/ui-layout/src/client/columns.ts:11` |
| `SIDEBAR_MIN` | 264 | 左栏拖拽下限 | `columns.ts:13` |
| `SIDEBAR_MAX` | 420 | 左栏拖拽上限 | `columns.ts:15` |
| `SIDEBAR_DEFAULT` | 280 | 左栏初始宽 | `columns.ts:17` |
| `SIDEBAR_COLLAPSED` | 56 | 折叠后的图标 rail 宽 | `columns.ts:19` |
| `SIDEBAR_AUTO_COLLAPSE` | 1024 | 视口低于此值自动折叠到 rail（对标 deepsuite LG 断点） | `columns.ts:20-23` |
| `RIGHTBAR_MIN` | 300 | 右栏下限 | `columns.ts:25` |
| `RIGHTBAR_MAX_RATIO` | 0.7 | 右栏最大占 frame 比例 | `columns.ts:27` |
| `RIGHTBAR_DEFAULT_RATIO` | 0.45 | 右栏首次打开占 frame 比例 | `columns.ts:29` |

求解顺序（`columns.ts:52-58`）：右栏先让位（`available = viewport - sidebar - CENTER_MIN`，不够 300 就整条轨道去掉），只有右栏被移除后中心才允许继续被压缩到 0。

### 3.2 断点

| 断点 | 触发 | 效果 | 证据 |
| --- | --- | --- | --- |
| 1024px | `viewport < SIDEBAR_AUTO_COLLAPSE` | 左栏**自动折叠成 56px rail**（macOS / Windows 标题栏模式折叠宽度为 0，完全隐藏列） | `AppFrame.tsx:160-161`、`:168-170`；`columns.ts:20-23` |
| 1024px（手动） | 用户在窄屏点折叠/展开 | 只翻转 `narrowExpanded`，**不动宽度偏好**；跨断点（无论方向）自动丢弃该覆盖 | `ui-layout/src/client/stores.ts:106-122` |
| 768px | `viewportWidth < 768` | 右栏强制全屏呈现（不改手动模式） | `SidebarRight.tsx:360-361`、`:367` |

### 3.3 窄屏下侧边栏如何"退化成抽屉"——**它没有退化成抽屉**

这是本次拆解最需要纠正的一个预设。桌面的窄屏路径是：

1. 自动折叠 → 56px 图标 rail（`SidebarRoot.tsx:113` 的 `wide` 计算；`columns.ts:19`）；
2. 用户在窄屏手动展开 → `narrowExpanded = true`（`ui-layout/src/client/stores.ts:110`）→ 网格照样给 264–420px 的列宽（`AppFrame.tsx:161-164`）→ 中心被**挤压**到 `max(0, viewport - sidebar - rightbar)`（`columns.ts:58`）；
3. **没有**遮罩层、**没有**绝对定位浮层、**没有**点击外部关闭、**没有** Esc 关闭。

全屏只有 `shell.overlay` 一层（`AppFrame.module.css:281-290`，`pointer-events: none` 的容器 + 子元素自动接管），它是对话框/通知用的（例如归档确认、toast），不是导航抽屉。`shell.leading`、`shell.bottom` 也都是常驻座位，不是抽屉（`AppFrame.tsx:289-299`）。

所以：
- 桌面版 = 「侧栏永远占位，只是变窄成 rail」；
- 移动端 = 「抽屉覆盖 + 遮罩 + 点外部关闭」（`src/components/drawer/AppDrawer.tsx:33-41`：`fixed inset-0 z-50 flex` + `bg-black/70 backdrop-blur-sm` 点击关闭 + `w-[320px] max-w-[85vw]` 侧滑）。

**结论：移动端的抽屉不是"桌面窄屏的对应物"，而是更进一步的替代。** 对齐时不要为了"和桌面一样"退回 rail——手机上 56px 图标列会让会话列表彻底不可用。反过来，如果将来做平板/桌面宽度（≥ 700px），可以借鉴 rail 思路。

### 3.4 其他响应式/平台细节（可借鉴）

| 项 | 做法 | 证据 |
| --- | --- | --- |
| 降动效 | `prefers-reduced-motion: reduce` 关掉轨道过渡与拖拽手柄过渡 | `AppFrame.module.css:52-56`、`:254-258` |
| 降透明度 | `prefers-reduced-transparency: reduce` 用 90% 不透明填充替代玻璃 | `AppFrame.module.css:145-150` |
| 平台外观 | `data-platform='darwin'`（vibrancy 渐变侧栏）、`data-windows-titlebar`（标题栏让位、圆角） | `AppFrame.module.css:26-50`、`:77-125`、`:168-193` |
| 指针模态 | `html[data-input-modality='pointer']` 下，非编辑控件不画焦点环 | `client/ui-theme/src/styles/focus.css:15-20` |
| 触屏反馈 | 移动端已有 `.studio-tap:active { scale(0.97) }` | `src/index.css:106-112` |

---

## 4. 主题（重点）

### 4.1 机制：三偏好 + 一个 body 属性 + 三层 token

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 偏好枚举 | `['light', 'dark', 'system']`，默认 `'system'` | `client/ui-theme/src/theme-settings.ts:6`、`:21` |
| 设置命名空间 / 字段 | `'ui-theme'` / `'preference'` | `theme-settings.ts:9`、`:12` |
| 首帧防闪 | 注入 head CSS：`color-scheme: light|dark` + `--dsh-boot-bg`（浅 `#fff` / 深 `#151517`）；system 用 `@media(prefers-color-scheme: dark)` | `client/ui-theme/src/boot-theme.ts:15-25` |
| 首帧属性 | body script：`document.documentElement.dataset.dsThemeSource = preference`，`document.body.toggleAttribute('data-ds-dark-theme', dark)`，并写字体大小/字体族变量 | `boot-theme.ts:28-44` |
| 运行时应用 | `ThemePresenter.apply()`：写 `html.style.colorScheme`、`html[data-ds-theme-source]`、`body[data-ds-dark-theme]`、三个字号变量、三种字体族变量、活动主题的 token 覆盖（inline CSS 变量）、`meta[name=theme-color]` | `client/ui-layout/src/client/theme-presenter.ts:16-28`、`:69-93` |
| 浅/深切换 selector | `body { … }` = 浅色；`body[data-ds-dark-theme] { … }` = 深色覆盖 | `client/ui-theme/src/styles/design-platform.css:166`、`:284` |
| token 表注入 | ui-theme 常驻注入 8 张样式表（`base/corner-shape/design-platform/focus/onboarding/scrollbar/gradient-shadow-text/shiki`） | `client/ui-theme/src/client/styles.ts:13-22`、`:28-39` |
| 设置项 UI | 外观三块：浅色 / 深色 / 跟随系统（`aria-pressed` 标记选中） | `client/ui-theme/src/client/AppearanceRow.tsx:31-35`、`:48-59`；文案 `client/ui-theme/src/client/locales.ts:5-8` |
| 字体轴 | `--dsh-content-font-size`（默认 14，范围 10–22）、`--dsh-code-font-size`（默认 11，10–16）、`--dsh-terminal-font-size`（默认 13，10–20） | `theme-settings.ts:57-61` |
| 平台特殊 | macOS 上 `--dsw-specific-menu` 保持近乎不透明（原生 vibrancy 下无法可靠模糊页面内容） | `design-platform.css:400-408` |

### 4.2 token 命名分层

```
--dsw-static-*      原始色板（77 个，浅/深两套，基本一一对应）
   ↑ 被引用
--dsw-alias-*       语义别名（bg / border / label / button / interactive / state / markdown / file-diff / code-diff / toast / tooltip / switch / link / scrollbar …，113 个中的绝大多数）
--dsw-specific-*    组件专用（sidebar、bubble、input、menu、selector、tip、login-input；以及 --dsw-menu-surface-fill / --dsw-alias-menu-group-header-fill）
```

**关键事实：**
- `design-platform.css` 声明了 **77 个 static + 113 个 alias/specific = 190 个 token**，浅色在 L166–282，深色覆盖在 L284–398。
- static 色板明暗两套**几乎完全相同**——唯一的差异是 `--dsw-static-neutral-bluish-60`（浅 `rgb(245,246,247)` L66 / 深 `rgb(249,250,251)` L147）。其余 76 个 static 值逐字节相同。
- alias 层 **97 个明暗不同值、16 个同值**（同值的 16 个：`bg-document-selection`、`bg-mask-3`、`bg-mask-photo`、`button-primary-fill`、`button-tool-bar-fill`、`button-tool-bar-fill-invisible`、`button-tool-bar-hover`、`state-error-secondary`、`state-success-primary`、`state-success-secondary`、`state-warn-label`、`state-warn-primary`、`state-warn-secondary`、`toast-label`、`tooltip-key-bg`、`specific-menu`）。
- 浅色的 `--dsw-alias-bg-base` = `neutral-bluish-00` = 纯白；深色 = `neutral-bluish-950` = `rgb(21,21,23)`（`design-platform.css:167` / `:285`）。

### 4.3 完整 token 清单

> 全部来自 `client/ui-theme/src/styles/design-platform.css`。`定义行` 是「浅色行 / 深色行」。

#### 4.3.1 原始色板 static（77 个）

| token | 值（明=暗） | 定义行（浅/暗） |
| --- | --- | --- |
| `--dsw-static-amber-100` | rgb(254, 245, 231) | 5 / 86 |
| `--dsw-static-amber-400` | rgb(247, 173, 49) | 6 / 87 |
| `--dsw-static-amber-500` | rgb(245, 158, 11) | 7 / 88 |
| `--dsw-static-amber-600` | rgb(221, 134, 41) | 8 / 89 |
| `--dsw-static-amber-900` | rgb(39, 36, 31) | 9 / 90 |
| `--dsw-static-blue-100` | rgb(219, 234, 254) | 10 / 91 |
| `--dsw-static-blue-300` | rgb(147, 197, 253) | 11 / 92 |
| `--dsw-static-blue-400` | rgb(96, 165, 250) | 12 / 93 |
| `--dsw-static-blue-450` | rgb(77, 147, 248) | 13 / 94 |
| `--dsw-static-blue-500` | rgb(59, 130, 246) | 14 / 95 |
| `--dsw-static-blue-50` | rgb(239, 246, 255) | 15 / 96 |
| `--dsw-static-blue-50p` | rgb(234, 243, 255) | 16 / 97 |
| `--dsw-static-blue-600` | rgb(37, 99, 235) | 17 / 98 |
| `--dsw-static-blue-75` | rgb(229, 240, 255) | 18 / 99 |
| `--dsw-static-blue-800` | rgb(30, 64, 175) | 19 / 100 |
| `--dsw-static-blue-900` | rgb(14, 48, 116) | 20 / 101 |
| `--dsw-static-blue-950` | rgb(23, 37, 84) | 21 / 102 |
| `--dsw-static-deepseek-100` | rgb(228, 237, 253) | 22 / 103 |
| `--dsw-static-deepseek-200` | rgb(211, 226, 255) | 23 / 104 |
| `--dsw-static-deepseek-300` | rgb(183, 200, 254) | 24 / 105 |
| `--dsw-static-deepseek-400` | rgb(122, 170, 255) | 26 / 107 |
| `--dsw-static-deepseek-450` | rgb(86, 134, 254) | 27 / 108 |
| `--dsw-static-deepseek-500` | rgb(65, 118, 230) | 28 / 109 |
| `--dsw-static-deepseek-50` | rgb(237, 243, 254) | 29 / 110 |
| `--dsw-static-deepseek-600` | rgb(72, 104, 178) | 30 / 111 |
| `--dsw-static-deepseek-700-delete` | rgb(47, 76, 143) | 31 / 112 |
| `--dsw-static-deepseek-800` | rgb(52, 65, 91) | 32 / 113 |
| `--dsw-static-deepseek-900` | rgb(40, 49, 66) | 33 / 114 |
| `--dsw-static-green-100` | rgb(230, 250, 237) | 34 / 115 |
| `--dsw-static-green-400` | rgb(78, 209, 126) | 35 / 116 |
| `--dsw-static-green-500` | rgb(34, 197, 94) | 36 / 117 |
| `--dsw-static-green-500-a08` | rgb(34 197 94 / 8%) | 37 / 118 |
| `--dsw-static-green-500-a12` | rgb(34 197 94 / 12%) | 38 / 119 |
| `--dsw-static-green-900` | rgb(35, 60, 44) | 39 / 120 |
| `--dsw-static-neutral-00` | rgb(255, 255, 255) | 40 / 121 |
| `--dsw-static-neutral-1000` | rgb(0, 0, 0) | 41 / 122 |
| `--dsw-static-neutral-100` | rgb(245, 245, 245) | 42 / 123 |
| `--dsw-static-neutral-150` | rgb(237, 237, 237) | 43 / 124 |
| `--dsw-static-neutral-200` | rgb(229, 229, 229) | 44 / 125 |
| `--dsw-static-neutral-250` | rgb(220, 220, 220) | 45 / 126 |
| `--dsw-static-neutral-300` | rgb(212, 212, 212) | 46 / 127 |
| `--dsw-static-neutral-400` | rgb(162, 164, 166) | 47 / 128 |
| `--dsw-static-neutral-500` | rgb(127, 130, 135) | 48 / 129 |
| `--dsw-static-neutral-50` | rgb(250, 250, 250) | 49 / 130 |
| `--dsw-static-neutral-550` | rgb(101, 103, 107) | 50 / 131 |
| `--dsw-static-neutral-600` | rgb(84, 85, 87) | 51 / 132 |
| `--dsw-static-neutral-700` | rgb(60, 60, 61) | 52 / 133 |
| `--dsw-static-neutral-800` | rgb(41, 41, 41) | 53 / 134 |
| `--dsw-static-neutral-850` | rgb(33, 33, 35) | 54 / 135 |
| `--dsw-static-neutral-900` | rgb(15, 15, 15) | 55 / 136 |
| `--dsw-static-neutral-bluish-00` | rgb(255, 255, 255) | 56 / 137 |
| `--dsw-static-neutral-bluish-1000` | rgb(15, 17, 21) | 57 / 138 |
| `--dsw-static-neutral-bluish-100` | rgb(235, 238, 242) | 58 / 139 |
| `--dsw-static-neutral-bluish-150` | rgb(233, 236, 242) | 59 / 140 |
| `--dsw-static-neutral-bluish-200` | rgb(225, 229, 238) | 60 / 141 |
| `--dsw-static-neutral-bluish-300` | rgb(207, 211, 214) | 61 / 142 |
| `--dsw-static-neutral-bluish-400` | rgb(173, 178, 184) | 62 / 143 |
| `--dsw-static-neutral-bluish-500` | rgb(151, 157, 166) | 63 / 144 |
| `--dsw-static-neutral-bluish-50` | rgb(249, 250, 251) | 64 / 145 |
| `--dsw-static-neutral-bluish-600` | rgb(129, 133, 140) | 65 / 146 |
| `--dsw-static-neutral-bluish-60` | **浅 rgb(245, 246, 247) / 暗 rgb(249, 250, 251)** | 66 / 147 |
| `--dsw-static-neutral-bluish-700` | rgb(97, 102, 107) | 67 / 148 |
| `--dsw-static-neutral-bluish-750` | rgb(67, 69, 74) | 68 / 149 |
| `--dsw-static-neutral-bluish-75` | rgb(241, 243, 245) | 69 / 150 |
| `--dsw-static-neutral-bluish-800` | rgb(53, 54, 56) | 70 / 151 |
| `--dsw-static-neutral-bluish-850` | rgb(44, 44, 46) | 71 / 152 |
| `--dsw-static-neutral-bluish-875` | rgb(35, 35, 36) | 72 / 153 |
| `--dsw-static-neutral-bluish-900` | rgb(27, 27, 28) | 73 / 154 |
| `--dsw-static-neutral-bluish-950` | rgb(21, 21, 23) | 74 / 155 |
| `--dsw-static-red-100` | rgb(254, 226, 226) | 75 / 156 |
| `--dsw-static-red-400` | rgb(242, 90, 90) | 76 / 157 |
| `--dsw-static-red-400-a12` | rgb(242 90 90 / 12%) | 77 / 158 |
| `--dsw-static-red-500` | rgb(239, 68, 68) | 78 / 159 |
| `--dsw-static-red-50` | rgb(254, 242, 242) | 79 / 160 |
| `--dsw-static-red-600` | rgb(236, 19, 19) | 80 / 161 |
| `--dsw-static-red-600-a08` | rgb(236 19 19 / 8%) | 81 / 162 |
| `--dsw-static-red-900` | rgb(87, 12, 12) | 82 / 163 |

#### 4.3.2 语义别名 alias / specific（113 个）

| token | 浅色 | 深色 | 定义行（浅/暗） |
| --- | --- | --- | --- |
| `--dsw-alias-bg-base` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-950) | 167 / 285 |
| `--dsw-alias-bg-document-preview` | var(--dsw-static-neutral-bluish-100) | var(--dsw-static-neutral-bluish-950) | 168 / 286 |
| `--dsw-alias-bg-document-selection` | color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent) | color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent) | 169 / 287 |
| `--dsw-alias-label-document-preview` | var(--dsw-static-neutral-bluish-700) | var(--dsw-static-neutral-bluish-300) | 170 / 288 |
| `--dsw-alias-bg-layer-1` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-875) | 171 / 289 |
| `--dsw-alias-bg-layer-2` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-850) | 172 / 290 |
| `--dsw-alias-bg-layer-3` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-800) | 173 / 291 |
| `--dsw-alias-bg-mask-1` | rgba(0, 0, 0, 0.24) | rgba(0, 0, 0, 0.5) | 174 / 292 |
| `--dsw-alias-bg-mask-2` | rgba(0, 0, 0, 0.12) | rgba(0, 0, 0, 0.2) | 175 / 293 |
| `--dsw-alias-bg-mask-3` | rgba(0, 0, 0, 0.48) | rgba(0, 0, 0, 0.48) | 176 / 294 |
| `--dsw-alias-bg-mask-photo` | rgba(0, 0, 0, 0.88) | rgba(0, 0, 0, 0.88) | 177 / 295 |
| `--dsw-alias-bg-mask-drop` | rgba(255, 255, 255, 0.7) | rgba(39, 39, 48, 0.7) | 178 / 296 |
| `--dsw-alias-bg-module-platform` | var(--dsw-static-neutral-bluish-60) | var(--dsw-static-neutral-bluish-800) | 179 / 297 |
| `--dsw-alias-bg-multi-select` | var(--dsw-static-neutral-bluish-60) | var(--dsw-static-neutral-850) | 180 / 298 |
| `--dsw-alias-bg-overlay` | var(--dsw-static-neutral-bluish-150) | var(--dsw-static-neutral-bluish-700) | 181 / 299 |
| `--dsw-alias-bg-skeleton` | rgba(0, 0, 0, 0.04) | rgba(255, 255, 255, 0.08) | 182 / 300 |
| `--dsw-alias-border-inverted2` | rgba(0, 0, 0, 0) | rgba(255, 255, 255, 0.08) | 183 / 301 |
| `--dsw-alias-border-inverted` | rgba(0, 0, 0, 0) | rgba(255, 255, 255, 0.06) | 184 / 302 |
| `--dsw-alias-border-l1` | rgba(0, 0, 0, 0.04) | rgba(255, 255, 255, 0.06) | 185 / 303 |
| `--dsw-alias-border-l2-darkmode-thin` | rgba(0, 0, 0, 0.1) | rgba(255, 255, 255, 0.06) | 186 / 304 |
| `--dsw-alias-border-l2` | rgba(0, 0, 0, 0.1) | rgba(255, 255, 255, 0.12) | 187 / 305 |
| `--dsw-alias-border-l3` | rgba(0, 0, 0, 0.12) | rgba(255, 255, 255, 0.16) | 188 / 306 |
| `--dsw-alias-border-l4` | rgba(0, 0, 0, 0.16) | rgba(255, 255, 255, 0.2) | 189 / 307 |
| `--dsw-alias-brand-primary-invert` | var(--dsw-static-neutral-bluish-1000) | var(--dsw-static-neutral-bluish-50) | 190 / 308 |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | rgb(65, 118, 230) | var(--dsw-static-deepseek-450) | 191 / 309 |
| `--dsw-alias-brand-primary` | var(--dsw-static-neutral-bluish-1000) | var(--dsw-static-neutral-bluish-50) | 192 / 310 |
| `--dsw-alias-brand-text` | var(--dsw-static-neutral-bluish-1000) | var(--dsw-static-neutral-bluish-50) | 193 / 311 |
| `--dsw-alias-button-contrast-fill` | var(--dsw-static-neutral-bluish-700) | var(--dsw-static-neutral-bluish-50) | 194 / 312 |
| `--dsw-alias-button-elevated-fill` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-750) | 195 / 313 |
| `--dsw-alias-button-floating-fill` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-850) | 196 / 314 |
| `--dsw-alias-button-floating-hover` | var(--dsw-static-neutral-bluish-75) | var(--dsw-static-neutral-bluish-800) | 197 / 315 |
| `--dsw-alias-button-ghost-active-border` | var(--dsw-static-neutral-bluish-500) | var(--dsw-static-neutral-bluish-600) | 198 / 316 |
| `--dsw-alias-button-ghost-active-fill` | var(--dsw-static-neutral-bluish-100) | var(--dsw-static-neutral-bluish-750) | 199 / 317 |
| `--dsw-alias-button-ghost-active-hover` | var(--dsw-static-neutral-bluish-150) | var(--dsw-static-neutral-bluish-700) | 200 / 318 |
| `--dsw-alias-button-info-fill` | var(--dsw-static-deepseek-500) | var(--dsw-static-deepseek-400) | 201 / 319 |
| `--dsw-alias-button-info-hover` | var(--dsw-static-deepseek-400) | var(--dsw-static-deepseek-500) | 202 / 320 |
| `--dsw-alias-button-primary-dimmed` | var(--dsw-static-neutral-bluish-100) | var(--dsw-static-neutral-bluish-750) | 203 / 321 |
| `--dsw-alias-button-primary-fill` | var(--dsw-alias-brand-primary) | var(--dsw-alias-brand-primary) | 204 / 322 |
| `--dsw-alias-button-primary-hover` | var(--dsw-static-neutral-bluish-750) | var(--dsw-static-neutral-bluish-100) | 205 / 323 |
| `--dsw-alias-button-tool-bar-fill-invisible` | rgba(31, 31, 31, 0.36) | rgba(31, 31, 31, 0.36) | 206 / 324 |
| `--dsw-alias-button-tool-bar-fill` | rgba(84, 85, 87, 0.5) | rgba(84, 85, 87, 0.5) | 207 / 325 |
| `--dsw-alias-button-tool-bar-hover` | rgba(84, 85, 87, 0.6) | rgba(84, 85, 87, 0.6) | 208 / 326 |
| `--dsw-alias-interactive-bg-active` | rgba(38, 49, 72, 0.1) | rgba(255, 255, 255, 0.14) | 209 / 327 |
| `--dsw-alias-interactive-bg-hover-accent` | rgba(38, 49, 72, 0.14) | rgba(255, 255, 255, 0.24) | 210 / 328 |
| `--dsw-alias-interactive-bg-hover-danger` | rgba(236, 19, 19, 0.05) | rgba(242, 90, 90, 0.15) | 211 / 329 |
| `--dsw-alias-interactive-bg-hover-solid` | var(--dsw-static-neutral-bluish-75) | var(--dsw-static-neutral-bluish-800) | 212 / 330 |
| `--dsw-alias-interactive-bg-hover` | rgba(38, 49, 72, 0.06) | rgba(255, 255, 255, 0.08) | 213 / 331 |
| `--dsw-alias-label-caption` | var(--dsw-static-neutral-bluish-400) | var(--dsw-static-neutral-bluish-600) | 214 / 332 |
| `--dsw-alias-label-deep-diving` | color-mix(in srgb, var(--dsw-static-deepseek-500) 70%, var(--dsw-static-blue-950)) | color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, var(--dsw-static-neutral-bluish-400)) | 215 / 333 |
| `--dsw-alias-label-deep-diving-shimmer` | color-mix(in srgb, var(--dsw-static-deepseek-500) 30%, var(--dsw-static-blue-950)) | color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-deepseek-400)) | 216 / 334 |
| `--dsw-alias-label-dimmed` | var(--dsw-static-neutral-bluish-200) | var(--dsw-static-neutral-bluish-750) | 217 / 335 |
| `--dsw-alias-label-primary-bluish` | var(--dsw-static-blue-900) | var(--dsw-static-neutral-bluish-50) | 218 / 336 |
| `--dsw-alias-label-primary-dimmed` | var(--dsw-static-neutral-bluish-950) | var(--dsw-static-neutral-bluish-100) | 219 / 337 |
| `--dsw-alias-label-primary-foreground` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-1000) | 220 / 338 |
| `--dsw-alias-label-primary-inverted` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-800) | 221 / 339 |
| `--dsw-alias-label-primary` | var(--dsw-static-neutral-bluish-1000) | var(--dsw-static-neutral-bluish-50) | 222 / 340 |
| `--dsw-alias-label-secondary` | var(--dsw-static-neutral-bluish-700) | var(--dsw-static-neutral-bluish-300) | 223 / 341 |
| `--dsw-alias-label-shimmer` | color-mix(in srgb, var(--dsw-static-neutral-1000) 30%, transparent) | color-mix(in srgb, var(--dsw-static-neutral-00) 45%, transparent) | 224 / 342 |
| `--dsw-alias-label-tertiary` | var(--dsw-static-neutral-bluish-600) | var(--dsw-static-neutral-bluish-400) | 225 / 343 |
| `--dsw-alias-menu-icon` | var(--dsw-static-neutral-bluish-800) | var(--dsw-alias-label-primary-dimmed) | 226 / 344 |
| `--dsw-alias-link` | var(--dsw-static-deepseek-500) | var(--dsw-static-deepseek-400) | 227 / 345 |
| `--dsw-alias-markdown-citation` | var(--dsw-static-neutral-bluish-100) | var(--dsw-static-neutral-bluish-800) | 228 / 346 |
| `--dsw-alias-markdown-code-block-banner` | var(--dsw-static-neutral-bluish-50) | var(--dsw-static-neutral-bluish-850) | 229 / 347 |
| `--dsw-alias-markdown-code-block` | var(--dsw-static-neutral-bluish-50) | var(--dsw-static-neutral-bluish-900) | 230 / 348 |
| `--dsw-alias-markdown-code-segment-selected` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-800) | 231 / 349 |
| `--dsw-alias-markdown-code-segment-unselected` | var(--dsw-static-neutral-bluish-75) | var(--dsw-static-neutral-bluish-900) | 232 / 350 |
| `--dsw-alias-markdown-inline-code` | var(--dsw-static-neutral-50) | var(--dsw-static-neutral-800) | 233 / 351 |
| `--dsw-alias-markdown-placeholder` | var(--dsw-static-neutral-bluish-60) | var(--dsw-static-neutral-bluish-850) | 234 / 352 |
| `--dsw-alias-markdown-tag` | var(--dsw-static-neutral-bluish-75) | var(--dsw-static-neutral-bluish-850) | 235 / 353 |
| `--dsw-alias-scrollbar-bg-l1` | var(--dsw-static-neutral-200) | var(--dsw-static-neutral-700) | 236 / 354 |
| `--dsw-alias-scrollbar-bg-l2` | var(--dsw-static-neutral-200) | var(--dsw-static-neutral-600) | 237 / 355 |
| `--dsw-alias-scrollbar-hover-l1` | var(--dsw-static-neutral-300) | var(--dsw-static-neutral-600) | 238 / 356 |
| `--dsw-alias-scrollbar-hover-l2` | var(--dsw-static-neutral-300) | var(--dsw-static-neutral-550) | 239 / 357 |
| `--dsw-alias-state-business-primary` | var(--dsw-static-deepseek-500) | var(--dsw-static-deepseek-400) | 240 / 358 |
| `--dsw-alias-state-business-tertiary` | var(--dsw-static-deepseek-100) | var(--dsw-static-deepseek-800) | 241 / 359 |
| `--dsw-alias-code-diff-added` | var(--dsw-static-green-500-a08) | var(--dsw-static-green-500-a12) | 242 / 360 |
| `--dsw-alias-code-diff-deleted` | var(--dsw-static-red-600-a08) | var(--dsw-static-red-400-a12) | 243 / 361 |
| `--dsw-alias-file-diff-added-bg` | rgb(230, 244, 231) | rgb(31, 49, 36) | 244 / 362 |
| `--dsw-alias-file-diff-added-gutter` | rgb(237, 247, 237) | rgb(19, 32, 22) | 245 / 363 |
| `--dsw-alias-file-diff-added-marker` | rgb(1, 162, 65) | rgb(65, 201, 119) | 246 / 364 |
| `--dsw-alias-file-diff-deleted-bg` | rgb(252, 230, 226) | rgb(60, 31, 27) | 247 / 365 |
| `--dsw-alias-file-diff-deleted-gutter` | rgb(253, 236, 233) | rgb(40, 19, 14) | 248 / 366 |
| `--dsw-alias-file-diff-deleted-marker` | rgb(186, 39, 35) | rgb(250, 66, 62) | 249 / 367 |
| `--dsw-alias-state-error-primary` | var(--dsw-static-red-600) | var(--dsw-static-red-400) | 250 / 368 |
| `--dsw-alias-state-error-secondary` | var(--dsw-static-red-400) | var(--dsw-static-red-400) | 251 / 369 |
| `--dsw-alias-state-idle-primary` | var(--dsw-static-neutral-300) | var(--dsw-static-neutral-600) | 252 / 370 |
| `--dsw-alias-state-success-primary` | var(--dsw-static-green-500) | var(--dsw-static-green-500) | 253 / 371 |
| `--dsw-alias-state-success-secondary` | var(--dsw-static-green-400) | var(--dsw-static-green-400) | 254 / 372 |
| `--dsw-alias-state-success-tertiary` | var(--dsw-static-green-100) | var(--dsw-static-green-900) | 255 / 373 |
| `--dsw-alias-state-warn-label` | var(--dsw-static-amber-600) | var(--dsw-static-amber-600) | 256 / 374 |
| `--dsw-alias-state-warn-primary` | var(--dsw-static-amber-500) | var(--dsw-static-amber-500) | 257 / 375 |
| `--dsw-alias-state-warn-secondary` | var(--dsw-static-amber-400) | var(--dsw-static-amber-400) | 258 / 376 |
| `--dsw-alias-state-warn-tertiary` | var(--dsw-static-amber-100) | var(--dsw-static-amber-900) | 259 / 377 |
| `--dsw-alias-switch-thumb` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-400) | 260 / 378 |
| `--dsw-alias-toast-bg` | var(--dsw-static-neutral-bluish-800) | var(--dsw-static-neutral-bluish-750) | 261 / 379 |
| `--dsw-alias-toast-label` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-00) | 262 / 380 |
| `--dsw-alias-tooltip-bg` | var(--dsw-static-neutral-bluish-850) | var(--dsw-static-neutral-bluish-750) | 263 / 383 |
| `--dsw-alias-tooltip-key-bg` | color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%) | color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%) | 264 / 384 |
| `--dsw-alias-turn-trigger-bg` | var(--dsw-alias-markdown-code-block) | var(--dsw-alias-interactive-bg-hover) | 265 / 381 |
| `--dsw-alias-turn-trigger-bg-hover` | var(--dsw-alias-interactive-bg-hover) | var(--dsw-alias-interactive-bg-active) | 266 / 382 |
| `--dsw-specific-bubble-highlight` | var(--dsw-static-deepseek-200) | var(--dsw-static-neutral-bluish-750) | 267 / 385 |
| `--dsw-specific-bubble` | var(--dsw-static-deepseek-50) | var(--dsw-static-neutral-bluish-850) | 268 / 386 |
| `--dsw-specific-input-major` | var(--dsw-static-neutral-bluish-00) | var(--dsw-static-neutral-bluish-850) | 269 / 387 |
| `--dsw-specific-login-input` | var(--dsw-static-neutral-bluish-50) | var(--dsw-static-neutral-bluish-900) | 270 / 388 |
| `--dsw-menu-surface-fill` | rgba(248, 249, 250, 0.58) | rgba(67, 69, 74, 0.45) | 271 / 389 |
| `--dsw-alias-menu-group-header-fill` | rgba(248, 249, 250, 0.94) | rgba(48, 49, 54, 0.94) | 272 / 390 |
| `--dsw-specific-menu` | var(--dsw-menu-surface-fill) | var(--dsw-menu-surface-fill) | 273 / 391 |
| `--dsw-specific-selector` | var(--dsw-static-neutral-bluish-60) | var(--dsw-static-neutral-bluish-800) | 274 / 392 |
| `--dsw-specific-sidebar-fill` | var(--dsw-static-neutral-bluish-50) | var(--dsw-static-neutral-bluish-900) | 275 / 393 |
| `--dsw-specific-sidebar-nav-item-active-accent` | var(--dsw-static-deepseek-100) | var(--dsw-static-neutral-bluish-800) | 276 / 394 |
| `--dsw-specific-sidebar-nav-item-active` | var(--dsw-static-neutral-bluish-100) | var(--dsw-static-neutral-bluish-750) | 277 / 395 |
| `--dsw-specific-sidebar-nav-item-hover` | var(--dsw-static-neutral-bluish-75) | var(--dsw-static-neutral-bluish-850) | 278 / 396 |
| `--dsw-specific-tip` | var(--dsw-static-neutral-bluish-60) | var(--dsw-static-neutral-bluish-800) | 279 / 397 |

**侧边栏最相关的 5 个：** `--dsw-specific-sidebar-fill`（浅 `#f9fafb` / 深 `#1b1b1c`）、`--dsw-specific-sidebar-nav-item-hover`、`-active`、`-active-accent`、`--dsw-alias-border-l3`（列分隔线）。

#### 4.3.3 非颜色 token

| 类别 | token | 值 | 证据 |
| --- | --- | --- | --- |
| 文本字体 | `--dsh-font-family-text-default` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', …` | `client/ui-theme/src/styles/base.css:7-8` |
| 品牌字体 | `--dsw-font-family-brand` | `'Montserrat', <文本栈>` | `base.css:10` |
| 代码字体 | `--dsh-font-family-code-default` | `'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, …`（刻意不带裸 `monospace`，否则 Windows 中文回退到宋体） | `base.css:11-12` |
| 用户覆盖槽 | `--dsh-font-family-text` / `--dsh-font-family-code` / `--dsh-font-family-terminal` | 由 boot script / ThemePresenter 写在 body 上 | `base.css:30-31`；`theme-presenter.ts:41-45` |
| 动效曲线 | `--ds-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | `base.css:14` |
| 动效时长 | `--ds-transition-duration` / `-fast` / `-slow` | `0.2s` / `0.1s` / `0.3s` | `base.css:15-17` |
| 圆角 | `--dsw-radius-xs/sm/md/lg/xl/panel` | `4 / 8 / 12 / 16 / 20 / 28px` | `base.css:18-23` |
| 焦点环 | `--dsw-focus-ring-width`；颜色回落 `--dsw-alias-state-business-primary` | `2px`；`--dsw-focus-ring-color` 由组件按需覆盖 | `client/ui-theme/src/styles/focus.css:2-13` |
| 指针模态 | `html[data-input-modality='pointer']` → 非编辑控件 `--dsw-focus-ring-color: transparent` | — | `focus.css:15-20` |
| 滚动条 | `--dsh-scrollbar-thumb` / `-thumb-hover` / `-thumb-border` / `-track-margin` / `-width` | 映射到 `--dsw-alias-scrollbar-bg-l1` / `hover-l1`；默认宽 `5px` | `client/ui-theme/src/styles/scrollbar.css:17-25` |
| 内容字号派生 | `--dsh-content-font-delta` / `--dsh-content-font-size-secondary` / `--dsh-code-font-delta` | 由 `--dsh-content-font-size`（默认 14px）、`--dsh-code-font-size`（默认 11px）派生 | `client/ui-theme/src/styles/gradient-shadow-text.css:57-63` |
| 设置卡 | `--dsw-alias-settings-card-fill` / `-stroke` | 映射到 `--dsw-alias-bg-layer-2` / `--dsw-alias-border-l4` | `base.css:32-33` |

### 4.4 移动端现状与迁移映射

**现状（写作时快照）：**

| 事实 | 证据 |
| --- | --- |
| `src/index.css` 已经定义了 **15 个** 变量，但只有深色一套（无 `[data-*]` 变体、无浅色） | `src/index.css:4-21` |
| 这 15 个变量基本没被使用：组件里是 **约 531 处硬编码 hex（快照）**，分布在 23 个文件 | 统计口径：`src/**/*.{ts,tsx,css}` 中 `#rgb/#rrggbb` 出现次数；热点 `ChatScreen.tsx` 82、`SessionsScreen.tsx` 57、`DisclosureToolCard.tsx` 55、`PairScreen.tsx` 44、`HostsScreen.tsx` 40、`MarkdownView.tsx` 40（合计 531，并行开发会继续变动） |
| `html, body` 底色写死 `#090a0f`，正文 `#f8fafc` | `src/index.css:35-36` |
| 玻璃/描边/网格背景/触感都写死在 class 里 | `src/index.css:59-103`、`:106-112` |
| 语法高亮配色表独立维护 | `src/lib/highlight.ts`（14 处 hex） |

**迁移映射（移动端现有变量 → 桌面 alias）：**

| 移动端（`src/index.css:4-21`） | 现值（深色） | 建议映射的桌面 token | 浅色取值 |
| --- | --- | --- | --- |
| `--bg-canvas` | `#090a0f` | `--dsw-alias-bg-base`（会话区底）/ `--dsw-specific-sidebar-fill`（侧栏底） | `#ffffff` / `#f9fafb` |
| `--bg-surface` | `#0e1118` | `--dsw-alias-bg-layer-1` | `#ffffff` |
| `--bg-surface-card` | `#12151f` | `--dsw-alias-bg-layer-2` | `#ffffff` |
| `--bg-surface-elevated` | `#151822` | `--dsw-alias-bg-layer-3` | `#ffffff` |
| `--color-primary` | `#3b82f6` | `--dsw-alias-state-business-primary`（浅深分别是 deepseek-500/400；若想保持品牌蓝，用 `--dsw-static-blue-500`） | `rgb(65,118,230)` / `rgb(122,170,255)` |
| `--color-primary-active` | `#2563eb` | `--dsw-alias-button-primary-hover`（注意桌面主按钮其实是黑白主色，品牌蓝只在 info/link） | `rgb(67,69,74)` |
| `--color-border-subtle` | `rgba(255,255,255,.08)` | `--dsw-alias-border-l2` | `rgba(0,0,0,.1)` |
| `--color-border-specular` | `rgba(255,255,255,.14)` | `--dsw-alias-border-l3` | `rgba(0,0,0,.12)` |
| `--color-text-main` | `#f8fafc` | `--dsw-alias-label-primary` | `rgb(15,17,21)` |
| `--color-text-muted` | `#94a3b8` | `--dsw-alias-label-secondary` | `rgb(97,102,107)` |
| `--color-text-dim` | `#64748b` | `--dsw-alias-label-tertiary` | `rgb(129,133,140)` |
| `--color-tool` | `#a855f7` | 无对应（桌面工具标记用 `--dsw-alias-menu-icon` / 状态色）；建议保留为品牌紫 | — |
| `--color-success` | `#10b981` | `--dsw-alias-state-success-primary` | `rgb(34,197,94)` |
| `--color-danger` | `#f43f5e` | `--dsw-alias-state-error-primary` | `rgb(236,19,19)` |
| `--color-warning` | `#f59e0b` | `--dsw-alias-state-warn-primary` | `rgb(245,158,11)` |
| （缺） | — | `--dsw-alias-bg-mask-1`（抽屉遮罩） | `rgba(0,0,0,.24)` |
| （缺） | — | `--dsw-alias-interactive-bg-hover`（列表 hover/按压） | `rgba(38,49,72,.06)` |
| （缺） | — | `--dsw-alias-link` | `rgb(65,118,230)` |
| （缺） | — | `--dsw-alias-markdown-code-block` / `-inline-code` / `-tag`（聊天区代码块） | 见 §4.3.2 |

**落地建议（按顺序做，每步可独立验收）：**

1. 在 `src/index.css` 建 `:root`（浅色）与 `[data-ds-dark-theme]`（深色）两套，直接抄 §4.3 里用得到的子集；`html` 上按 `localStorage` 或系统偏好设置 `data-ds-dark-theme`（与桌面属性名相同，将来若做桌面/平板共用代码可零成本对齐）。
2. 先把 `--bg-*` / `--color-text-*` / `--color-border-*` 换进 5 个热点文件（`ChatScreen` / `SessionsScreen` / `DisclosureToolCard` / `AppDrawer` / `SessionCard`），一次只换一类，跑一次视觉检查。
3. 再处理语义色（状态点、成功/失败、工具紫），最后处理玻璃与网格背景（`.specular-card` / `.studio-glass` / `.mesh-glow-bg`，`src/index.css:59-103`）——这些在浅色下必须整体重做（现在是不透明白色的渐变+白色内阴影，浅色会糊成一片）。
4. 语法高亮（`src/lib/highlight.ts`）单独一张 token 表，参考 `--dsw-alias-markdown-*`。

---

## 5. 移动端差异清单（桌面 hover / 多栏 / 拖拽 → 触摸替代）

| 桌面交互 | 桌面实现（证据） | 手机替代方案 |
| --- | --- | --- |
| **hover 才出现的折叠箭头** | 工作区行箭头只在 hover 出现（`rows/Rows.tsx:262-264`） | 手机上箭头必须常显；整行点击即折叠/展开（移动端已如此：`SessionGroupSection.tsx` 用 `CollapsibleSection` 整行按钮） |
| **hover 才出现的行动作** | 会话行的 `…` 菜单与动作按钮在 hover 时出现（`rows/Rows.tsx:664-690`） | 常显 `…` 按钮（移动端已有 `SessionActionMenu.tsx`）；或长按整行出菜单 |
| **hover 卡（800ms 停留）** | 工作区/会话 hover 卡显示完整路径、时间、状态、复制（`rows/Rows.tsx:313-329`、`:427-458`；`README.md:185-187`） | 长按 → 底部 sheet 展示同样字段；「复制路径/标题」做成 sheet 内的按钮 |
| **hover 标题 marquee 滚动** | 标题超宽时 hover 匀速滚到末尾（`rows/Rows.tsx:102-134`） | 去掉动效；改为两行截断或长按查看全文 |
| **指针位置驱动的滚动条** | 指针在列内才画滚动条，离开 2s 后隐藏（`SidebarRoot.tsx:33-39`、`:129-170`） | 触摸端：滚动时显示、停止后淡出（`-webkit-overflow-scrolling: touch` 已启用，`src/index.css:38`） |
| **拖拽排序会话 / 工作区** | HTML5 DnD：`draggable` + `dragover`/`drop`，插入标记按行的上/下半区判定（`rows/Rows.tsx:574`、`:599-625`；`WorkspaceBrowser.tsx:418-454`、`:206-239`） | 不做拖拽。改为行菜单里的「置顶 / 上移 / 下移」，或进入「排序模式」后拖动（jQuery-free 可用 pointer events）。**注意桌面同时把排序模式切成 manual**（`client/ui-workspace/src/client/stores.ts:114-119`），移动端若实现要一并持久化 |
| **分屏 / 浮窗 / 跨 pane 拖 tab** | dockkit（`ui-dockkit/src/contract/types.ts:137-192`） | 不做（§2.4） |
| **拖拽列宽** | 8px 手柄 + pointer capture + rAF 节流（`AppFrame.tsx:58-118`、`:301-304`） | 不做；抽屉宽度固定 85vw 上限 |
| **多栏并排** | 三列 grid（`AppFrame.tsx:258-274`） | 单列 + 路由；抽屉覆盖；右栏（若做）全屏覆盖 |
| **快捷键** | `Mod+K` 搜索、`Mod+Alt+G` 重命名、`Mod+Alt+B` 右栏、`Mod+\` 分屏…（`README.md:62`；`ui-sidebar-right/src/client/shortcuts.ts:28-96`） | 手机没有键盘。保留 `aria-keyshortcuts` 标注（外接键盘可用），但每个快捷键动作都必须有一个可点入口 |
| **双击标题重命名** | `onDoubleClick`（`rows/Rows.tsx:640-642`） | 行菜单里的「重命名」（移动端已有 dialog） |
| **右键 / 上下文菜单** | 未见右键实现，动作都走 `…` 菜单 | 长按 → sheet |
| **文本选择与复制** | 桌面可选中；复制走 hover 卡/菜单（`rows/Rows.tsx:700-702`） | 移动端要显式提供「复制」，且避免 `user-select: none` 挡住长按复制（`SessionsScreen.tsx` 用了 `select-none`，会话列表里要放开） |

---

## 6. 结论与施工建议

### 6.1 已经对齐（不用再动）

- 会话列表「按工作区分组 + 可折叠」的形态与桌面方向一致。
- 折叠的可访问性（`aria-expanded` / `aria-controls` / `useId`）比桌面散落实现更规范，保留。
- `localStorage` key 自带版本号（移动端 `v1`，桌面 `v5`）的习惯一致。
- 搜索「本地即时 + 250ms 防抖远端」与桌面同构（移动端甚至更严：远端结果单独成组 + 去重计数）。

### 6.2 明确的差距（按价值排序）

1. **主题**：桌面有 190 个 token 的三层体系且明暗双份；移动端 15 个变量 + 约 531 处硬编码（快照）。§4.3 的表是可直接施工的输入，这是最大的一块。
2. **归档语义**：桌面归档是 Host 能力（`workspace/archiveSession` / `unarchiveSession`，`packages/api/workspace-controller/src/index.ts:159-171`，状态持久在 Host registry：`packages/workspace/workspace/src/spec.ts:62`，并以 `{type:'archived'}` 帧推给客户端：`packages/api/workspace-controller/src/feed.ts:119-122`）；移动端只能本机归档。当前文案（`src/lib/session-groups.ts:39`）如实写明，✔ 保持；若将来网关补 `workspace/*` 端点，这里是接缝。
3. **分组语义**：桌面按 Workspace 实体（可重命名、可嵌套、Host 持久顺序），移动端按 cwd 字符串。若移动端要显示「桌面给工作区起的名字」，需要网关也暴露 workspace 列表；否则保持 cwd basename 是务实选择。
4. **每组条数上限**：桌面默认 5 条 + 「显示更多」水位（自动涨到覆盖 running/pending/current），移动端 12 条 + 收起。两套都行，但移动端的 12 是固定的，长列表首屏会更长；建议把「随注意力自动抬高」的思路抄过来（`WorkspaceBrowser.tsx:77-94`）。
5. **搜索结果 20 条上限**：桌面有 `hasMore` 提示（`WorkspaceBrowser.tsx:880-884`），移动端目前没有上限也没有提示。建议补上。

### 6.3 建议的落地顺序

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| P0 | 落地主题 token（§4.4 四步），先做浅色可切换 | 无 |
| P1 | 归档区/搜索上限/每组条数的细节对齐 | 无 |
| P2 | 做右栏的移动版：单面板 + tab 条 + `text`/`files` 两个 kind | 网关要有 `session.page` 之外的文件读取能力（现状缺，需先确认） |
| P3 | 平板宽度（≥700px）布局：左栏常驻 + 右栏 push | P2 |

---

## 附：本文引用到的桌面文件清单

| 文件 | 用途 |
| --- | --- |
| `client/ui-sidebar/src/client/SidebarRoot.tsx` | 左栏壳：列几何、品牌行、新建、全局面板行、三个洞 |
| `client/ui-sidebar/src/client/contract/slots.ts` | 左栏洞契约（`sidebar.workspaces` / `sidebar.settings` / `panellist`） |
| `client/ui-sidebar/src/client/SidebarRoot.module.css` | rail 尺寸、面板行圆角、滚动条安静化 |
| `client/ui-workspace/src/client/tree.ts` | 分组、排序、归档过滤、搜索合并的全部纯逻辑 |
| `client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` | 浏览区 UI：视图选项、搜索、树/单列表、水位、拖拽 |
| `client/ui-workspace/src/client/rows/Rows.tsx` | 工作区行 / 会话行 / 搜索结果行的字段与交互 |
| `client/ui-workspace/src/client/stores.ts` | 视图状态与 `dsh.workspace.view.v5` 持久化 |
| `client/ui-workspace/README.md` | 设计意图（水位、manual、树嵌套、归档、hover 卡） |
| `client/ui-layout/src/client/AppFrame.tsx` | 三列网格、拖拽手柄、断点判定 |
| `client/ui-layout/src/client/columns.ts` | 全部列宽常量与求解 |
| `client/ui-layout/src/client/stores.ts` | `narrowExpanded` 与断点行为 |
| `client/ui-layout/src/client/theme-presenter.ts` | 主题 DOM 应用器 |
| `client/ui-theme/src/styles/design-platform.css` | **190 个颜色 token 的唯一出处** |
| `client/ui-theme/src/styles/base.css` / `focus.css` / `scrollbar.css` | 字体、圆角、动效、焦点环、滚动条 token |
| `client/ui-theme/src/theme-settings.ts` / `src/boot-theme.ts` | 偏好枚举、字号轴、首帧防闪 |
| `client/ui-sidebar-right/src/client/shell/SidebarRight.tsx` | 右栏 panel：呈现模式、折叠、chrome、dockkit 接线 |
| `client/ui-sidebar-right/src/client/shell/ExpandButton.tsx` | 折叠后的入口 |
| `client/ui-sidebar-right/src/client/persistence.ts` / `shortcuts.ts` | 右栏布局持久化 / 快捷键 |
| `client/ui-dockkit/src/contract/types.ts` | 停靠模型（pane / split / float / zone / mode） |
| `client/ui-sidebar-files` · `ui-sidebar-terminal` · `ui-sidebar-browser` · `ui-sidebar-documentpreview` · `ui-deliverables` | 各 tab kind 的注册定义 |
| `packages/api/workspace-controller/src/index.ts` · `src/feed.ts`、`packages/workspace/workspace/src/spec.ts` | 桌面归档是 Host 能力的证据 |