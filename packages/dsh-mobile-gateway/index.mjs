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
  const profile = ctx.get?.('profileContext');
  return {
    id: profile?.id ?? null,
    name: profile?.name ?? process.env.DSH_PROFILE ?? 'desktop',
    home: profile?.home ?? resolveDshHome(),
    node: process.version,
    platform: process.platform,
    startedAt: Date.now(),
  };
}

export async function apply(ctx, userConfig) {
  const config = { ...defaults, ...(userConfig ?? {}) };
  const dshHome = resolveDshHome();
  const dataDir = resolvePath(config.dataDir, join(dshHome, 'dsh-mobile-gateway'));
  const log = createLogger(join(dataDir, 'gateway.log'), { minLevel: config.logLevel, console: true });

  if (!config.enabled) {
    log.info('disabled by config; registering nothing');
    return () => {};
  }

  // webServer / connection / typertGateway 都是异步就绪的，必须 inject 等它们，
  // 否则启动竞态下路由会静默丢失（dsh-bot-gateway 为此专门注掉了 webserver 行的 deps）。
  const disposeServices = await ctx.inject(['webServer', 'connection', 'typertGateway']);
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

  const disposers = [];

  // ---- 健康检查（公开，只回最小事实） ------------------------------------
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/mobile-gateway/health',
      handler(_req, res) {
        sendJson(res, 200, {
          ok: true,
          service: 'dsh-mobile-gateway',
          version: PLUGIN_VERSION,
          instance: { name: instance.name, home: instance.home },
        });
      },
    }),
  );

  // ---- 配对（用一次性配对码换长期设备令牌） -------------------------------
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/mobile-gateway/pair',
      async handler(req, res) {
        try {
          const body = await readJsonBody(req);
          const result = await store.redeem(body.code, {
            ttlMs: config.tokenTtlMs,
            deviceName: body.deviceName,
            platform: body.platform,
          });
          if (!result.ok) {
            sendError(res, result.reason === 'no_active_code' ? 404 : 403, result.reason, pairErrorText(result.reason));
            log.warn('pairing rejected', { reason: result.reason, remote: req.socket?.remoteAddress });
            return;
          }
          log.info('device paired', { deviceId: result.device.id, name: result.device.name });
          sendJson(res, 200, {
            device: result.device,
            token: result.token,
            instance,
            apiPrefix: '/mobile-gateway/api',
            events: { mux: '/mobile-gateway/events.mux', host: '/mobile-gateway/events.host' },
          });
        } catch (error) {
          sendError(res, error?.statusCode ?? 500, 'pair_failed', String(error?.message ?? error));
        }
      },
    }),
  );

  // ---- `/api` 桥 ----------------------------------------------------------
  const API_PREFIX = '/mobile-gateway/api/';
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      async handler(req, res) {
        const apiPath = (req.url ?? '/').split('?')[0].slice(API_PREFIX.length - 1);
        try {
          await bridge.handleApi(req, res, apiPath);
        } catch (error) {
          log.error('api bridge failed', { apiPath, error: String(error?.message ?? error) });
          sendError(res, error?.statusCode ?? 500, 'bridge_failed', String(error?.message ?? error));
        }
      },
    }),
  );

  // ---- 管理面板（仅回环） -------------------------------------------------
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: '/mobile-gateway/',
      async handler(req, res) {
        const pathname = (req.url ?? '/').split('?')[0];
        try {
          if (await handleManage(req, res, pathname)) return;
          sendError(res, 404, 'not_found', `no mobile-gateway route for ${pathname}`);
        } catch (error) {
          sendError(res, error?.statusCode ?? 500, 'internal_error', String(error?.message ?? error));
        }
      },
    }),
  );

  // ---- 两条下行事件流 -----------------------------------------------------
  for (const endpoint of ['/api/events.mux', '/api/events.host']) {
    const path = endpoint.replace('/api/', '/mobile-gateway/');
    disposers.push(
      webServer.registerUpgrade({
        path,
        handler(req, socket, head) {
          bridge.handleEventsUpgrade(req, socket, head, endpoint);
        },
      }),
    );
  }

  log.info('mobile gateway ready', {
    dataDir,
    instance: instance.name,
    manageUrl: '/mobile-gateway/manage',
    devices: store.list().length,
  });

  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    disposeServices();
    await bridge.dispose();
    await store.flush();
    log.info('mobile gateway stopped');
  };
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

export { PLUGIN_VERSION };