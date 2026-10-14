const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

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