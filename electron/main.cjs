const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
} = require('electron');
const path = require('path');

// 平台降级逻辑单独放在**纯模块**里（不依赖 electron），
// 这样它能被 scripts/test-desktop-notify.mjs 在无显示器环境下逐条钉死。
const { buildNotificationOptions, normalizeKind } = require('./notification-options.cjs');

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
// ─────────────────────────────────────────────────────────────────────────────

/** 允许退出的标志：只有走托盘菜单的「退出」才真的退。 */
let isQuitting = false;
/** 主窗口引用；关窗后置空但进程继续活着。 */
let mainWindow = null;
/** 托盘引用；必须保持强引用，否则会被 GC 回收、图标消失。 */
let tray = null;

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

/** 把窗口顶到用户眼前 —— 窗口「关掉」其实只是 hide（常驻设计），多半正躲在托盘里。 */
function revealWindow() {
  const win = createWindow(); // 已有窗口 → show+focus；已被销毁 → 重建
  if (!win || win.isDestroyed()) return null;
  win.show();
  win.focus();
  return win;
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
  const eventId =
    rawPayload && typeof rawPayload.eventId === 'string' ? rawPayload.eventId.trim() : '';
  if (!eventId) {
    console.warn('[notify] 丢弃负载：eventId 缺失或不是字符串');
    return;
  }

  const kind = normalizeKind(rawPayload.kind);
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
      `[notify] decision eventId=${eventId} allow=${allow === null ? 'null' : allow} via=${via}`,
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
    sendToRenderer(win, APPROVAL_ACTION_CHANNEL, { eventId, allow });
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
 * Windows 通知的前提。
 *
 * 🔴 不设 AppUserModelID 的话，`new Notification()` **不报错、静默丢弃** ——
 * 审批通知发不出去，且没有任何错误可查。开发期（未打包）也要显式设。
 * 参考：https://www.electronjs.org/docs/latest/tutorial/notifications
 */
if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.dshmobile.app');
}

function resolveAsset(name) {
  // dev 用 public/，打包后 Vite 会把 public/ 拷进 dist/
  const candidates = [
    path.join(__dirname, '../dist', name),
    path.join(__dirname, '../public', name),
  ];
  const fs = require('fs');
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 440,
    height: 920,
    minWidth: 380,
    minHeight: 700,
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

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
  const prodPath = path.join(__dirname, '../dist/index.html');

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    win.loadURL(devUrl).catch(() => {
      win.loadFile(prodPath);
    });
  } else {
    win.loadFile(prodPath);
  }

  // 关窗只是**隐藏**，不销毁 —— 进程与连接继续活着（这是常驻的关键）。
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
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
  tray.setToolTip('DSH 远程控制 · 正在守护与电脑的连接');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => createWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // 左键点托盘 → 显示/聚焦窗口（Windows/Linux 习惯）
  tray.on('click', () => createWindow());
}

// 单实例：第二个实例直接把已有窗口顶到前面，然后自己退出。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createWindow();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      // macOS：点 Dock 图标时恢复窗口
      createWindow();
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
});