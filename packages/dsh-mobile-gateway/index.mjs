/**
 * @file index.mjs
 * @description DSH Mobile Gateway —— 原生移动端的进程内鉴权网关。
 *
 * 路线选择（与 dsh-remote-web-ui / dsh-mobile 的区别）：
 *   - 前两者把**官方 Web GUI**送到手机（浏览器或 WebView 薄壳），手机上跑的仍是桌面界面。
 *   - 本插件不送界面，只送**协议**：官方 `/api` 在进程内经设备令牌鉴权后桥接到手机，
 *     由独立的原生 App 呈现。DSH 源码零改动。
 *
 * 暴露的四个面：
 *   GET  /mobile-gateway/health            公开的最小健康信息
 *   POST /mobile-gateway/pair              用一次性配对码换长期设备令牌
 *   POST /mobile-gateway/api/<method...>   已鉴权的 `/api` 桥（官方 envelope 透传）
 *   WS   /mobile-gateway/events.mux|host   已鉴权的两条下行事件流
 *   GET  /mobile-gateway/manage            仅回环的管理面板（铸码 / 二维码 / 设备吊销）
 *
 * 安装：插件页安装后，在 `cordis.patch.yml` 注册一行
 *     - id: mobile-gateway
 *       name: dsh-mobile-gateway
 * 管理面板： http://127.0.0.1:<dsh 端口>/mobile-gateway/manage
 */

import { join } from 'node:path';
import { createLogger, resolveDshHome, resolvePath } from './lib/util.mjs';
import { DeviceStore } from './lib/store.mjs';
import { createBridge, PRIVILEGED_METHODS, PRIVILEGED_PREFIXES } from './lib/bridge.mjs';
import { createManageApi } from './lib/manage.mjs';
import { sendError, sendJson, readJsonBody } from './lib/http.mjs';

export const name = 'mobile-gateway';

const PLUGIN_VERSION = '0.1.0';

export const defaults = {
  /** 总开关。关掉后下面所有路由都不注册。 */
  enabled: true,
  /** 运行时数据目录，留空 = $DSH_HOME/dsh-mobile-gateway */
  dataDir: '',
  /** 配对码有效期（毫秒）。 */
  pairingTtlMs: 5 * 60_000,
  /** 设备令牌有效期（毫秒），默认 30 天。 */
  tokenTtlMs: 30 * 24 * 60 * 60_000,
  /** 公网地址。二维码里放的是这个地址；留空则面板退化为手动输入配对码。 */
  publicBaseUrl: '',
  /**
   * 对已配对设备不可达的 RPC 方法。默认复刻官方「仅回环」的那张特权名单——
   * 见 lib/bridge.mjs 顶部说明。留空数组 = 不额外限制（不推荐）。
   */
  deniedMethods: PRIVILEGED_METHODS,
  deniedPrefixes: PRIVILEGED_PREFIXES,
  /** 日志级别：debug | info | warn | error */
  logLevel: 'info',
};

function resolveInstance(ctx) {
  const profile = safeGet(ctx, 'profileContext');
  return {
    id: profile?.id ?? null,
    name: profile?.name ?? process.env.DSH_PROFILE ?? 'desktop',
    home: profile?.home ?? resolveDshHome(),
    node: process.version,
    platform: process.platform,
    startedAt: Date.now(),
  };
}

/**
 * `ctx.get(name)` 在服务尚未就绪时会直接抛错，而插件的 apply 跑在启动竞态里。
 * 这里一律吞掉：拿不到就用缺省值，**绝不能让一次探测失败把整个 fiber 带崩**。
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx, userConfig) {
  const config = { ...defaults, ...(userConfig ?? {}) };
  const dshHome = resolveDshHome();
  const dataDir = resolvePath(config.dataDir, join(dshHome, 'dsh-mobile-gateway'));
  const log = createLogger(join(dataDir, 'gateway.log'), { minLevel: config.logLevel, console: true });

  // 先落一行盘：fiber 失败时 DSH 不会把异常交给我们，这里是唯一的现场证据。
  log.info('applying', { version: PLUGIN_VERSION, node: process.version, dataDir });

  if (!config.enabled) {
    log.info('disabled by config; registering nothing');
    return () => {};
  }

  /**
   * `ctx.inject(服务名[], 回调)` —— 第二个参数是**回调**，不是能 await 成 disposer 的东西。
   * 回调在三个服务都就绪后执行，参数是该子 fiber；服务要从**它**身上取。
   *
   * 踩过的坑：写成 `await ctx.inject([...])` 之后用 `ctx.webServer`，
   * cordis 会在解析参数时抛 `Cannot read properties of undefined (reading 'name')`，
   * fiber 直接 failed。本机可用的 dsh-bot-gateway 是这么写的：
   *
   *     ctx.inject(['webServer'], mountWebuiRoutes);
   *     // 回调里：webCtx.effect(() => webServer.register({...}), '标签')
   *
   * 这里还把整个启动包了一层 try/catch 并落盘，保证再出问题时有现场可查。
   */
  ctx.inject(['webServer', 'connection', 'typertGateway'], async (fiberCtx) => {
    try {
      await start(fiberCtx, config, log, dataDir);
    } catch (error) {
      log.error('apply failed', {
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | '),
      });
      await log.flush();
      // 不再往上抛：宁可停在「未就绪」，也不要让一个附属插件把宿主的 fiber 弄崩。
    }
  });

  return () => {};
}

async function start(ctx, config, log, dataDir) {
  const { webServer } = ctx;

  const instance = { ...resolveInstance(ctx), gatewayVersion: PLUGIN_VERSION };
  const store = new DeviceStore(join(dataDir, 'devices.json'), log);
  await store.load();

  const bridge = createBridge({ ctx, store, log, config });
  const handleManage = createManageApi({
    store,
    log,
    config,
    instance,
    gatewayVersion: PLUGIN_VERSION,
    describeChannel: bridge.describe,
  });

  // 路由注册挂在 fiber 的 effect 上：fiber 卸载时由 cordis 统一回收，
  // 不用自己维护 disposer 数组（本机 dsh-bot-gateway 的 webui 路由也是这个写法）。

  // ---- 所有 HTTP 面共用**一个** prefix 路由，在内部按 pathname 分派 ---------
  // 不拆成 exact + prefix：`/mobile-gateway/pair` 会被 `/mobile-gateway/` 这个
  // prefix 命中，拆开就得依赖「exact 优先于 prefix」这条未公开的调度顺序。
  const API_PREFIX = '/mobile-gateway/api/';

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        // 🔴 path **不能带尾部斜杠**。
        // 写成 '/mobile-gateway/' 时 DSH 只匹配这一个精确字符串，
        // /mobile-gateway/health 会直接落到宿主兜底 404（空响应体），
        // 表现为「路由明明注册成功却全部 404」，且日志里毫无异常。
        // 对照本机能正常工作的 dsh-bot-gateway：它注册的是 '/bot-gateway'，
        // 于是 /bot-gateway/anything 也能命中（实测确认）。
        path: '/mobile-gateway',
        async handler(req, res) {
          const pathname = (req.url ?? '/').split('?')[0];
          try {
            if (pathname === '/mobile-gateway/health') {
              sendJson(res, 200, {
                ok: true,
                service: 'dsh-mobile-gateway',
                version: PLUGIN_VERSION,
                instance: { name: instance.name, home: instance.home },
              });
              return;
            }

            // 账号密码登录：比配对码好记。两条入口并存，签发的令牌同构。
            if (pathname === '/mobile-gateway/login') {
              if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', '请用 POST 登录');
              const body = await readJsonBody(req);
              const result = await store.login(body.username, body.password, {
                ttlMs: config.tokenTtlMs,
                deviceName: body.deviceName,
                platform: body.platform,
              });
              if (!result.ok) {
                sendError(res, 401, result.reason, loginErrorText(result.reason));
                log.warn('login rejected', { reason: result.reason, remote: req.socket?.remoteAddress });
                return;
              }
              log.info('device logged in', { deviceId: result.device.id, name: result.device.name });
              sendJson(res, 200, {
                device: result.device,
                token: result.token,
                instance,
                apiPrefix: API_PREFIX,
                events: { mux: '/mobile-gateway/events.mux', host: '/mobile-gateway/events.host' },
              });
              return;
            }

            if (pathname === '/mobile-gateway/pair') {
              if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', '请用 POST 配对');
              const body = await readJsonBody(req);
              const result = await store.redeem(body.code, {
                ttlMs: config.tokenTtlMs,
                deviceName: body.deviceName,
                platform: body.platform,
              });
              if (!result.ok) {
                sendError(
                  res,
                  result.reason === 'no_active_code' ? 404 : 403,
                  result.reason,
                  pairErrorText(result.reason),
                );
                log.warn('pairing rejected', { reason: result.reason, remote: req.socket?.remoteAddress });
                return;
              }
              log.info('device paired', { deviceId: result.device.id, name: result.device.name });
              sendJson(res, 200, {
                device: result.device,
                token: result.token,
                instance,
                apiPrefix: API_PREFIX,
                events: { mux: '/mobile-gateway/events.mux', host: '/mobile-gateway/events.host' },
              });
              return;
            }

            if (pathname.startsWith(API_PREFIX)) {
              // 🔴 这里必须是 API_PREFIX.length，**不能减 1**。
              // API_PREFIX 以 '/' 结尾（'/mobile-gateway/api/'），减 1 会留下一个前导
              // 斜杠，拼出 `http://127.0.0.1/api//host.describe` 这种双斜杠路径。
              // 宿主 connection 的 endpointFromPath 会因「空路径段」直接判为非法
              // endpoint 并返回 404 "not found"（不是我们的错误体）。
              // 这个 off-by-one 让整条 /api 桥在真机上完全不可用，而进程内测试
              // 因为直接调 bridge.handleApi(...) 绕过了这一行，50 项断言全绿也没发现。
              await bridge.handleApi(req, res, pathname.slice(API_PREFIX.length));
              return;
            }

            if (await handleManage(req, res, pathname)) return;

            sendError(res, 404, 'not_found', `no mobile-gateway route for ${pathname}`);
          } catch (error) {
            const status = error?.statusCode ?? 500;
            log.error('http route failed', { pathname, error: String(error?.message ?? error) });
            sendError(res, status, status === 500 ? 'internal_error' : 'bad_request', String(error?.message ?? error));
          }
        },
      }),
  );

  // ---- 两条下行事件流 -----------------------------------------------------
  for (const endpoint of ['/api/events.mux', '/api/events.host']) {
    const path = endpoint.replace('/api/', '/mobile-gateway/');
    ctx.effect(
      () =>
        webServer.registerUpgrade({
          path,
          handler(req, socket, head) {
            bridge.handleEventsUpgrade(req, socket, head, endpoint);
          },
        }),
      `dsh-mobile-gateway: upgrade ${path}`,
    );
  }

  log.info('mobile gateway ready', {
    dataDir,
    instance: instance.name,
    manageUrl: '/mobile-gateway/manage',
    devices: store.list().length,
  });
  await log.flush();
  // 注意：这里**不要**再跟 bridge.dispose() / store.flush()。
  // 那三行原本属于 apply 的 disposer 函数体，删 disposer 时若把函数体留在
  // start() 末尾，就会出现「刚 ready 就 stopped」——路由注册完立刻被自己拆掉，
  // 表现为健康检查恒 404，而日志两行都是 info，看着像正常启停。
}

function pairErrorText(reason) {
  switch (reason) {
    case 'malformed':
      return '配对码格式不正确';
    case 'no_active_code':
      return '当前没有有效配对码，请在电脑上重新生成';
    default:
      return '配对码不匹配';
  }
}

function loginErrorText(reason) {
  switch (reason) {
    case 'no-credentials':
      return '电脑端还没设置密码，请先在管理面板生成';
    case 'too-short':
      return '密码太短（至少 6 位）';
    default:
      return '账号或密码不对';
  }
}

export { PLUGIN_VERSION };