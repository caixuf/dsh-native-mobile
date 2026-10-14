const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  screen,
} = require('electron');
const fs = require('fs');
const path = require('path');

// 平台降级逻辑单独放在**纯模块**里（不依赖 electron），
// 这样它能被 scripts/test-desktop-notify.mjs 在无显示器环境下逐条钉死。
const { buildNotificationOptions } = require('./notification-options.cjs');

// 托盘状态、窗口几何、单实例唤回、通知深链的**纯函数**（同样不依赖 electron）。
// 这四件事的失败模式都是「不报错但行为错」：tooltip 永远写着错的连接状态、
// 窗口被恢复到已拔掉的屏幕上、第二个实例启动后用户看不到任何反应。
// 所以判定逻辑必须能从无显示器环境里逐条调用（见 scripts/test-desktop-notify.mjs §J–§M）。
const {
  DEFAULT_WINDOW,
  WINDOW_STATE_FILE,
  buildApprovalAction,
  buildRelayStatusText,
  buildTrayMenuModel,
  normalizeDeepLink,
  normalizeRelayStatus,
  parseWindowStateFile,
  planWindowReveal,
  resolveWindowState,
  serializeWindowState,
} = require('./desktop-state.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// 主进程职责（2026-10-14 补齐）
//
// 原来的 main.cjs 只有一个 BrowserWindow，47 行。补了三件**必须**的事：
//
// 1. **常驻不退出** —— 原实现 `window-all-closed → app.quit()`，
//    关窗即杀进程。而本产品的核心场景是「电脑端等你授权 → 手机收到通知」，
//    连接必须活到用户处理完。窗口关掉就退出的话，**核心能力直接失效**。
//
// 2. **托盘** —— 常驻就必须给用户一个「回到应用 / 真正退出」的入口，
//    否则用户找不到窗口也退不掉（只能杀进程）。这不是装饰，是常驻的配套。
//
// 3. **单实例** —— 常驻应用很容易被重复启动（点两次图标就有两个进程、
//    两条长连接、两套通知）。用 requestSingleInstanceLock 收敛成一个。
//
// 2026-10-15 再补四件「常驻久了才发现缺」的事（判定逻辑都在 desktop-state.cjs，可测）：
//
// 4. **托盘状态与操作** —— tooltip 显示连接状态 + 待审批数（渲染进程经
//    `dsh:relay-status` 上报），菜单补「显示主窗口 / 重新连接 / 退出」，
//    重新连接经 `dsh:relay-reconnect` 通知渲染进程（重连状态机仍在渲染进程）。
// 5. **通知点击深链** —— 通知带 `sessionId`，用户点了直接跳到对应会话的待审批项，
//    不用自己在一堆会话里找。决定负载仍带 eventId/allow（向后兼容）。
// 6. **窗口状态记忆** —— 几何存到 userData/window-state.json；
//    屏幕被拔掉导致坐标越界时回落主屏居中（否则窗口存在但用户永远看不到）。
// 7. **第二个实例唤回隐藏窗口** —— 窗口可能被隐藏或最小化，必须 show + restore + focus。
// ─────────────────────────────────────────────────────────────────────────────

/** 允许退出的标志：只有走托盘菜单的「退出」才真的退。 */
let isQuitting = false;
/** 主窗口引用；关窗后置空但进程继续活着。 */
let mainWindow = null;
/** 托盘引用；必须保持强引用，否则会被 GC 回收、图标消失。 */
let tray = null;
/** 渲染进程上报的中继状态（tooltip 用）；托盘还没建起来时先存在这里。 */
let relayStatus = normalizeRelayStatus(null);
/** 上一次写进 tooltip 的文案：这个通道会随心跳定期上报，只在变化时写日志。 */
let lastRelayStatusText = '';
/** 窗口几何落盘的防抖定时器：拖动窗口会连续打出几十个 resize 事件。 */
let windowStateSaveTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// 桌面审批通知（2026-10-15 补齐）
//
// 上面那段注释说「不设 AppUserModelID 就会静默丢弃」，但**之前一行通知都没发过** ——
// 也就是「坑写在注释里，护栏没建」。本段把那句话兑现：
//
//   · 主进程是**信任边界**：preload 挡过一层，这里再校验一次（见 dispatchApprovalNotification）；
//   · 平台差异（谁有按钮、谁必须靠点击回窗口）全在 notification-options.cjs 里，
//     这里只负责「按当前平台的结论去发」；
//   · **一定要打派发日志**：这条链路的失败模式是「什么都没发生」，
//     没有日志就无法区分「没弹」和「系统吞了」。
// ─────────────────────────────────────────────────────────────────────────────

/** 通道名必须与 electron/preload.cjs 逐字一致，改名要两边同时改。 */
const NOTIFY_CHANNEL = 'dsh:notify-approval';
const APPROVAL_ACTION_CHANNEL = 'dsh:approval-action';
/** 上行：渲染进程上报连接状态（tooltip 用）。下行：托盘「重新连接」请求。 */
const RELAY_STATUS_CHANNEL = 'dsh:relay-status';
const RELAY_RECONNECT_CHANNEL = 'dsh:relay-reconnect';

/** 「通知不可用」只报一次：失败模式是静默，所以要留痕，但不必每条待办刷一次屏。 */
let notificationUnsupportedLogged = false;

/**
 * eventId → 该事件当前活着的那条 Notification。
 *
 * 同一个待办被推送两次（渲染进程重连、effect 重跑）时必须**先关掉旧的那条**，
 * 否则通知中心会出现两条一模一样的授权请求，用户点哪条都说不清。
 *
 * 点击/按钮回调需要的 payload 用**闭包**捕获（比再查一次 Map 更直接、
 * 也不可能出现「Map 里被覆盖了所以点错事件」）。Electron 在 notification 对象上也
 * 提供 `notification.eventId` / `notification.action` 两个 getter，但它们只在事件
 * 发生之后才有值；事件参数 + 闭包是更明确的写法。
 */
const liveNotifications = new Map();

/**
 * 按 planWindowReveal 的结论把窗口真正交到用户眼前。
 *
 * 🔴 单独的 `win.show()` 不够：窗口「关掉」只是 hide（常驻设计），
 * 但第二个实例启动时窗口还可能是**最小化**状态 —— 只 show 不 restore，
 * 用户的观感就是「点了图标什么都没发生」，然后反复双击。
 */
function applyRevealPlan(win, plan) {
  for (const step of plan) {
    if (step === 'show') win.show();
    else if (step === 'restore') win.restore();
    else if (step === 'focus') win.focus();
  }
}

/**
 * 把窗口顶到用户眼前 —— 窗口「关掉」其实只是 hide（常驻设计），多半正躲在托盘里。
 *
 * 「什么时候 show、什么时候 restore、什么时候只 focus」由纯函数
 * planWindowReveal 决定，这样「隐藏窗口必须能被唤回」这件事在无显示器环境里也能测。
 * createWindow 对「已有窗口」也会走同一套唤回，所以这里不重复补一次。
 */
function revealWindow() {
  const win = createWindow(); // 已有窗口 → 唤回；已被销毁 → 重建
  return win && !win.isDestroyed() ? win : null;
}

/**
 * 把用户的决定送回渲染进程。
 *
 * 窗口刚创建、页面还没加载完时 `webContents.send` 会**丢**，
 * 所以先等 did-finish-load 再发（丢了等于用户批了但界面还在等）。
 */
function sendToRenderer(win, channel, data) {
  const wc = win && win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  const deliver = () => {
    if (!wc.isDestroyed()) wc.send(channel, data);
  };
  if (wc.isLoading()) wc.once('did-finish-load', deliver);
  else deliver();
  return true;
}

/**
 * 通知发不出去时的降级路径。
 *
 * Windows 的 toast 除了 AppUserModelID（文件顶部已设）之外，
 * 在某些系统策略下还要求应用**已安装 / 注册到开始菜单**才显示。
 * 这里**不**去偷偷装快捷方式（那属于安装器的事，静默写开始菜单是越权），
 * 只降级到托盘气泡，再不行就把窗口顶到前面 ——
 * 「电脑端等你授权」不能因为通知不可用就变成没人知道。
 */
function degradeToTrayOrWindow(options, eventId) {
  if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
    try {
      tray.displayBalloon({ title: options.title, content: options.body });
      console.warn(`[notify] 降级：已改用托盘气泡提醒 eventId=${eventId}`);
      return;
    } catch (err) {
      console.warn(`[notify] 托盘气泡也不可用（${err && err.message}），改为顶起窗口`);
    }
  }
  revealWindow();
  console.warn(`[notify] 降级：已把窗口顶到前面 eventId=${eventId}（请在应用内处理）`);
}

/**
 * 收到渲染进程的请求 → 发一条桌面通知，并把用户在通知上的操作送回渲染进程。
 *
 * @param {unknown} rawPayload 来自 ipcMain 的负载，**不可信**
 */
function dispatchApprovalNotification(rawPayload) {
  // 主进程侧再校验一次：preload 挡的是「正常调用」，挡不住
  // 「渲染进程被注入脚本后照样调 preload 方法」这种情况。
  // 深链字段（kind / sessionId）与 eventId 一起在这里归一化。
  // 🔴 sessionId 是「点了通知之后该跳到哪个会话」的唯一依据：
  //    丢了它，窗口是弹出来了，但用户还得自己在会话列表里找那条待审批。
  const link = normalizeDeepLink(rawPayload);
  if (!link) {
    console.warn('[notify] 丢弃负载：eventId 缺失或不是字符串');
    return;
  }
  const { eventId, kind, sessionId } = link;
  const options = buildNotificationOptions({
    title: rawPayload.title,
    body: rawPayload.body,
    kind,
    platform: process.platform,
  });

  // 🔴 派发日志（格式固定，便于用户/脚本 grep）：
  //    [notify] kind=approval actions=true eventId=ev-1 ...
  //    「没弹出来」和「弹了但被系统吞了」在终端里必须能分辨。
  console.log(
    `[notify] kind=${kind} actions=${options.hasActions} eventId=${eventId}` +
      ` platform=${process.platform} silent=${options.silent}` +
      ` title=${JSON.stringify(options.title)}`,
  );

  if (!Notification.isSupported()) {
    if (!notificationUnsupportedLogged) {
      notificationUnsupportedLogged = true;
      console.warn(
        '[notify] Notification.isSupported() === false —— 系统通知不可用，改用托盘/窗口提醒',
      );
    }
    degradeToTrayOrWindow(options, eventId);
    return;
  }

  const previous = liveNotifications.get(eventId);
  if (previous) {
    try {
      previous.close();
    } catch {
      // 已被系统回收 / 已关闭，忽略
    }
    liveNotifications.delete(eventId);
  }

  let notification;
  try {
    notification = new Notification({
      title: options.title,
      body: options.body,
      // 审批必须出声（buildNotificationOptions 保证 approval 的 silent=false）
      silent: options.silent,
      // actions 只在 macOS 有意义；不支持时这里是空数组，**绝不**传空 actions
      ...(options.actions.length > 0 ? { actions: options.actions } : {}),
      // sound 是 macOS 专属字段，其它平台传了没意义
      ...(options.sound ? { sound: options.sound } : {}),
    });
  } catch (err) {
    console.error(`[notify] 创建通知失败 eventId=${eventId}: ${err && err.message}`);
    return;
  }

  // 一次决定只送一次：macOS 上点按钮有可能同时触发 action 与 click，
  // 如果随后的 click(null) 覆盖掉刚送出的 allow=true，用户就会「批了却还在等」。
  let decided = false;

  const finish = (allow, via) => {
    if (decided) return;
    if (allow !== null) decided = true;
    liveNotifications.delete(eventId);
    console.log(
      `[notify] decision eventId=${eventId} allow=${allow === null ? 'null' : allow} via=${via}` +
        ` sessionId=${sessionId || '-'}`,
    );
    // 🔴 先 show+focus 再送决定：窗口通常藏在托盘里，
    //    不先顶起来的话，渲染进程就算保留了待办弹窗，用户也看不见。
    const win = revealWindow();
    if (!win) {
      console.warn(`[notify] 窗口不可用，决定未能送达渲染进程 eventId=${eventId}`);
      return;
    }
    // click 且无 action index → allow = null：
    // 含义是「只聚焦窗口，渲染进程**保持**待办弹窗可见」，不是「用户同意了」。
    // kind / sessionId 随之透传，渲染进程据此跳到对应会话的待审批项（老版本只读
    // eventId/allow，多出来的两个字段对它无害 —— 向后兼容）。
    const actionPayload = buildApprovalAction({ eventId, allow, kind, sessionId });
    if (!actionPayload) {
      console.warn(`[notify] 决定负载构造失败，未送达渲染进程 eventId=${eventId}`);
      return;
    }
    sendToRenderer(win, APPROVAL_ACTION_CHANNEL, actionPayload);
  };

  notification.on('click', () => finish(null, 'click'));
  notification.on('action', (_event, index) => {
    // macOS：index 0 = 允许一次，1 = 拒绝（与 notification-options.cjs 的按钮顺序一致）。
    // 其它索引**不猜**用户意图，退化成「只聚焦窗口」。
    if (index === 0) finish(true, 'action#0');
    else if (index === 1) finish(false, 'action#1');
    else finish(null, `action#${index}`);
  });
  notification.on('failed', (_event, error) => {
    console.error(`[notify] 系统投递失败 eventId=${eventId}: ${error}`);
    // 系统层面拒收（Windows 未注册到开始菜单是最常见的一种）
    if (!notificationUnsupportedLogged) {
      notificationUnsupportedLogged = true;
      degradeToTrayOrWindow(options, eventId);
    }
  });

  liveNotifications.set(eventId, notification);
  notification.show();
}

ipcMain.on(NOTIFY_CHANNEL, (_event, payload) => {
  try {
    dispatchApprovalNotification(payload);
  } catch (err) {
    // 通知失败绝不允许影响主流程（长连接、托盘、窗口）—— 那才是本产品的主业。
    console.error(`[notify] 处理通知请求时异常: ${err && err.stack ? err.stack : err}`);
  }
});

/**
 * 渲染进程上报中继状态 → 托盘 tooltip。
 *
 * 常驻应用的用户大部分时间不看窗口，tooltip 是**唯一常年在屏幕上**的状态面：
 * 不打开窗口也该能知道「连接还在不在、有几条待审批」。
 * 负载不可信，所以主进程侧用纯函数再归一化一次（preload 挡的是正常调用，
 * 挡不住「渲染进程被注入脚本后照样调 preload 方法」）。
 */
ipcMain.on(RELAY_STATUS_CHANNEL, (_event, payload) => {
  try {
    relayStatus = normalizeRelayStatus(payload);
    const text = buildRelayStatusText(relayStatus);
    if (tray && !tray.isDestroyed()) tray.setToolTip(text);
    // 只在这个通道**内容变化**时写日志：状态会随心跳定期上报，全量打会刷屏，
    // 而刷屏的日志等于没有日志 —— 真出问题时没人愿意在里面找那一行。
    if (text !== lastRelayStatusText) {
      lastRelayStatusText = text;
      console.log(`[relay] ${text}`);
    }
  } catch (err) {
    console.error(`[relay] 处理状态上报时异常: ${err && err.stack ? err.stack : err}`);
  }
});

/**
 * Windows 通知的前提。
 *
 * 🔴 不设 AppUserModelID 的话，`new Notification()` **不报错、静默丢弃** ——
 * 审批通知发不出去，且没有任何错误可查。开发期（未打包）也要显式设。
 * 参考：https://www.electronjs.org/docs/latest/tutorial/notifications
 */
if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.dshmobile.app');
}

// ─────────────────────────────────────────────────────────────────────────────
// 窗口状态记忆（2026-10-15 补齐）
//
// 常驻应用「关窗」只是隐藏，用户下次点托盘再打开时，如果窗口每次都跳回默认位置，
// 这对每天用好几次的人来说就是每次都要重新摆一次。所以尺寸/位置要记住。
//
// 🔴 但「记住」有一个致命边界：**屏幕可能被拔掉**（外接显示器下班拔走、
//    分辨率从 4K 改成 1080p、投屏结束）。原样恢复一个屏幕外的坐标，
//    表现是「窗口存在、托盘有图标、但屏幕上什么都没有」——
//    用户唯一的感受就是「这个程序坏了」。所以恢复前必须校验可见性，
//    越界一律回落为主屏居中（判定逻辑在 desktop-state.cjs 的 resolveWindowState 里，
//    可在无显示器环境下测试）。
// ─────────────────────────────────────────────────────────────────────────────

function windowStateFilePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

/** 读原始文本；文件不存在（首次启动）是正常路径，不是错误。 */
function readWindowStateFile() {
  try {
    return fs.readFileSync(windowStateFilePath(), 'utf8');
  } catch {
    return '';
  }
}

/** 把当前窗口几何写盘；任何失败都只告警 —— 记不住位置不该影响应用运行。 */
function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    // 🔴 最大化时 getBounds() 返回的是整屏尺寸，恢复出来会变成「尺寸等于屏幕但不最大化」
    //    的假最大化窗口；getNormalBounds() 才是还原后的真实几何。
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const text = serializeWindowState(bounds, maximized);
    if (!text) return;
    fs.writeFileSync(windowStateFilePath(), text, 'utf8');
  } catch (err) {
    console.warn(`[window-state] 保存失败：${err && err.message}`);
  }
}

/**
 * 拖动 / 缩放窗口会连续打出几十个 resize/move 事件，逐次写盘既费 IO 也没必要。
 * 400ms 防抖；真正的结束路径（托盘「退出」/ before-quit / 关窗隐藏）会强制落盘一次。
 */
function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    persistWindowState();
  }, 400);
}

function resolveAsset(name) {
  // dev 用 public/，打包后 Vite 会把 public/ 拷进 dist/
  const candidates = [
    path.join(__dirname, '../dist', name),
    path.join(__dirname, '../public', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 已有窗口：按它的**真实状态**唤回。
    // 隐藏（关窗只是 hide）→ show；最小化 → restore；最后 focus。
    // 🔴 这里不再只 show+focus：最小化的窗口 show() 之后用户依然看不见。
    applyRevealPlan(
      mainWindow,
      planWindowReveal({
        visible: mainWindow.isVisible(),
        minimized: mainWindow.isMinimized(),
      }),
    );
    return mainWindow;
  }

  // 屏幕拔掉 / 分辨率变化后的坐标越界在这里被挡住（回落主屏居中）。
  const resolved = resolveWindowState(
    parseWindowStateFile(readWindowStateFile()),
    screen.getAllDisplays(),
    DEFAULT_WINDOW,
  );
  console.log(
    `[window-state] ${resolved.reason}` +
      (resolved.bounds ? ` bounds=${JSON.stringify(resolved.bounds)}` : ' bounds=交给系统居中'),
  );

  const win = new BrowserWindow({
    // 越界 / 首次启动时 resolved.bounds 已经是「主屏居中」；
    // 拿不到显示器信息（bounds=null）就干脆不传 x/y，让 Electron 自己居中，
    // 好过在这里编一个 0,0 把窗口扔到主屏左上角。
    ...(resolved.bounds ? resolved.bounds : {}),
    minWidth: DEFAULT_WINDOW.minWidth,
    minHeight: DEFAULT_WINDOW.minHeight,
    title: 'DeepSeek Harness Remote Studio',
    backgroundColor: '#090a0f',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'ultra-dark',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 桌面通知桥：渲染进程通过 window.dshDesktop 请求弹通知 / 收决定。
      // 🔴 少了这一行，preload 不会执行 —— 而 renderer 里的 `window.dshDesktop`
      //    只是 undefined，调用它的代码「不报错也不弹通知」（又是静默失败）。
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // 记忆了最大化状态就还原（尺寸用的是 getNormalBounds，不会丢还原尺寸）。
  if (resolved.maximized) win.maximize();

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
  const prodPath = path.join(__dirname, '../dist/index.html');

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    win.loadURL(devUrl).catch(() => {
      win.loadFile(prodPath);
    });
  } else {
    win.loadFile(prodPath);
  }

  // 几何变化 → 防抖落盘。
  win.on('resize', scheduleWindowStateSave);
  win.on('move', scheduleWindowStateSave);

  // 关窗只是**隐藏**，不销毁 —— 进程与连接继续活着（这是常驻的关键）。
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      // 关窗即隐藏前先把几何落盘：防抖可能还没触发，而用户很可能就此退出。
      if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
      persistWindowState();
      win.hide();
    }
  });

  mainWindow = win;
  return win;
}

function createTray() {
  const iconPath = resolveAsset('favicon-32x32.png') || resolveAsset('apple-touch-icon.png');
  // 找不到图标时托盘会创建失败 —— 那会让「常驻」变成「退不掉」，
  // 所以这里显式报出来，不静默跳过。
  if (!iconPath) {
    console.error('[tray] 找不到托盘图标（public/favicon-32x32.png），托盘不可用');
    return;
  }

  tray = new Tray(nativeImage.createFromPath(iconPath));
  // tooltip = 连接状态 + 待审批数（渲染进程经 dsh:relay-status 上报）。
  tray.setToolTip(buildRelayStatusText(relayStatus));

  const handlers = {
    show: () => revealWindow(),
    reconnect: () => {
      const win = revealWindow();
      if (!win) {
        console.warn('[tray] 重新连接：窗口不可用，请求未送达渲染进程');
        return;
      }
      // 只发信号：重连策略仍归渲染进程（只有它知道中继/网关的状态机，
      // 主进程擅自重开会和渲染进程自己的重试逻辑打架）。
      sendToRenderer(win, RELAY_RECONNECT_CHANNEL, { reason: 'tray' });
      console.log('[tray] 已请求渲染进程重新连接');
    },
    quit: () => {
      isQuitting = true;
      // 「退出」是唯一真正结束进程的路径，几何必须在这里落盘。
      if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
      persistWindowState();
      app.quit();
    },
  };

  // 菜单项由纯函数给出（buildTrayMenuModel），这样「常驻应用必须有退出入口」
  // 和「必须有唤回窗口的入口」这两件事可以被测试钉住，而不是靠人肉检查。
  const template = [];
  for (const item of buildTrayMenuModel()) {
    const handler = handlers[item.id];
    if (typeof handler !== 'function') {
      console.warn(`[tray] 菜单项 ${item.id} 没有处理函数，已跳过`);
      continue;
    }
    // 分隔线放在「退出」之前：退出是破坏性操作，不该和日常操作挤在一起。
    if (item.id === 'quit') template.push({ type: 'separator' });
    template.push({ label: item.label, click: handler });
  }
  tray.setContextMenu(Menu.buildFromTemplate(template));

  // 左键点托盘 → 显示/聚焦窗口（Windows/Linux 习惯）
  tray.on('click', () => revealWindow());
}

// 单实例：第二个实例直接把已有窗口顶到前面，然后自己退出。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 🔴 第二个实例不是「再开一个窗口」，而是「用户想看到那个已经存在的窗口」。
    //    窗口此刻可能被隐藏（关窗只是 hide）或最小化，所以必须走 revealWindow
    //    （show + restore + focus）。只 createWindow() 的话窗口保持原样，
    //    用户的观感就是「双击图标没反应」—— 然后继续双击。
    revealWindow();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      // macOS：点 Dock 图标时恢复窗口（隐藏 / 最小化的都要能唤回）
      revealWindow();
    });
  });
}

/**
 * 🔴 关键改动：**不再在这里退出**。
 *
 * 原实现：
 *     app.on('window-all-closed', () => {
 *       if (process.platform !== 'darwin') app.quit();
 *     });
 *
 * 后果：Windows/Linux 上关掉窗口 = 进程结束 = 长连接断开 =
 *       **电脑端等你授权时，手机永远收不到**。
 *
 * 现在：窗口全关后进程继续活着（连接保持、托盘仍在），
 * 只有托盘菜单的「退出」或 `before-quit` 才真正结束。
 */
app.on('window-all-closed', () => {
  // 故意留空：常驻是本产品的必要行为，不是可选优化。
  // 用户要退出请走托盘菜单。
});

// 用户从系统层面退出（注销/关机等）时，标记为非「关窗隐藏」，让流程正常走完。
app.on('before-quit', () => {
  isQuitting = true;
  // 退出是最后一次落盘机会（防抖定时器可能还没触发）。
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = null;
  persistWindowState();
});