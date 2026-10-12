/**
 * @file lib/manage.mjs
 * @description 仅回环可达的管理面板：铸码、二维码、设备列表与逐设备吊销。
 *
 * 配对码是**完全控制凭据**的种子，因此这一页与铸造端点一律只应答回环 TCP 对端
 * （判据是 `req.socket.remoteAddress`，不是 Host 头——本机 profile 常把 webserver
 * 绑到 0.0.0.0，用 Host 判断会被自身配置误伤）。
 */

import QRCode from 'qrcode';
import { sendError, sendHtml, sendJson, readJsonBody } from './http.mjs';
import { isLoopbackAddress } from './util.mjs';

const PAGE = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 移动网关</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1f24; --muted:#6b7280; --line:#e5e7eb; --bg:#fbfbfc; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6e6e6; --muted:#9ca3af; --line:#2b2f36; --bg:#16181d; --card:#1e2128; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;
         color:var(--fg); background:var(--bg); display:flex; justify-content:center; }
  main { width:100%; max-width:720px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; font-size:13px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h2 { font-size:14px; margin:0 0 14px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .pair { display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
  .qr { width:180px; height:180px; background:#fff; border-radius:10px; padding:8px; flex:0 0 auto; }
  .qr svg { width:100%; height:100%; display:block; }
  code.code { font:600 16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.02em;
             background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 12px; display:inline-block; }
  .meta { color:var(--muted); font-size:12px; margin-top:10px; }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line);
           background:var(--bg); color:var(--fg); cursor:pointer; }
  button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
  button.danger { color:#dc2626; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.actions { text-align:right; white-space:nowrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#9ca3af; margin-right:6px; }
  .dot.on { background:#22c55e; }
  .empty { color:var(--muted); padding:10px 0; }
  .warn { border-left:3px solid #f59e0b; padding:10px 14px; background:rgba(245,158,11,.08);
          border-radius:0 8px 8px 0; color:var(--fg); font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>DSH 移动网关</h1>
  <p class="sub" id="subtitle">加载中…</p>

  <section>
    <h2>设备配对</h2>
    <div class="pair">
      <div class="qr" id="qr"></div>
      <div>
        <div id="pairArea"></div>
        <div class="meta" id="pairMeta"></div>
      </div>
    </div>
    <p style="margin:16px 0 0">
      <button class="primary" id="mint">刷新配对码</button>
      <span class="meta" style="margin-left:8px">刷新后旧码立即作废</span>
    </p>
  </section>

  <section>
    <h2>已配对设备</h2>
    <div id="devices"></div>
  </section>

  <section>
    <h2>安全须知</h2>
    <p class="warn">
      已配对设备是<strong>完全控制凭据</strong>：它能驱动这台电脑上的 DSH，包括会话、文件与工具。
      手机丢失时请立刻在这里吊销。配对码与设备令牌只在本机以 SHA-256 摘要形式落盘。<br>
      配置面、凭据面与插件安装面默认<b>不对手机开放</b>，它们只对本机回环生效。
    </p>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const api = (path, body) => fetch(path, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

async function refresh() {
  const { data } = await api('/mobile-gateway/manage/api/state');
  if (data.error) { $('subtitle').textContent = data.error.message; return; }
  $('subtitle').textContent =
    data.instance.name + ' · 网关版本 ' + data.gatewayVersion +
    (data.channel ? ' · 在线事件流 ' + data.channel.eventSockets : '');

  const pair = data.pairing;
  if (pair) {
    $('pairArea').innerHTML = '<code class="code">' + pair.display + '</code>';
    $('qr').innerHTML = pair.qrSvg || '<div class="meta">（二维码不可用，请手动输入配对码）</div>';
    $('pairMeta').textContent =
      '扫码或手动输入 · 有效期至 ' + fmtTime(pair.expiresAt) +
      (pair.pairUrl ? ' · 地址 ' + pair.pairUrl : ' · 未配置公网地址');
  } else {
    $('pairArea').innerHTML = '<span class="meta">当前没有有效配对码</span>';
    $('qr').innerHTML = '';
    $('pairMeta').textContent = '点击「刷新配对码」生成一枚新的';
  }

  const devices = data.devices || [];
  if (!devices.length) {
    $('devices').innerHTML = '<div class="empty">还没有配对任何设备。</div>';
  } else {
    $('devices').innerHTML =
      '<table><thead><tr><th>设备</th><th>状态</th><th>最近活动</th><th></th></tr></thead><tbody>' +
      devices.map((d) =>
        '<tr>' +
          '<td>' + d.name + '<div class="meta">' + d.platform + '</div></td>' +
          '<td><span class="dot' + (d.online ? ' on' : '') + '"></span>' + (d.online ? '在线' : '离线') + '</td>' +
          '<td class="meta">' + fmtTime(d.lastSeenAt) + '</td>' +
          '<td class="actions">' +
            '<button data-act="rotate" data-id="' + d.id + '">重置令牌</button> ' +
            '<button class="danger" data-act="revoke" data-id="' + d.id + '">吊销</button>' +
          '</td>' +
        '</tr>').join('') +
      '</tbody></table>';
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'mint') {
    btn.disabled = true;
    await api('/mobile-gateway/manage/api/mint', {});
    btn.disabled = false;
    await refresh();
    return;
  }
  const act = btn.dataset.act;
  if (!act) return;
  if (act === 'revoke' && !confirm('吊销后该设备需要重新配对，确定？')) return;
  btn.disabled = true;
  await api('/mobile-gateway/manage/api/' + act, { deviceId: btn.dataset.id });
  btn.disabled = false;
  await refresh();
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

export function createManageApi({ store, log, config, instance, gatewayVersion, describeChannel }) {
  async function qrSvgFor(text) {
    try {
      return await QRCode.toString(text, { type: 'svg', margin: 1, width: 320 });
    } catch (error) {
      log.warn('qr render failed', { error: String(error) });
      return null;
    }
  }

  /** 二维码里放的是什么，取决于是否配置了公网地址。 */
  function pairPayload() {
    const base = (config.publicBaseUrl || '').trim().replace(/\/+$/, '');
    return base ? `${base}/mobile-gateway/pair` : null;
  }

  function guard(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendError(res, 403, 'loopback_only', '管理面只应答回环来源');
      return false;
    }
    return true;
  }

  async function statePayload() {
    const pairing = store.currentPairing();
    const pairUrl = pairPayload();
    return {
      gatewayVersion,
      instance,
      devices: store.list(),
      channel: describeChannel?.() ?? null,
      pairing: pairing
        ? {
            ...pairing,
            pairUrl,
            qrSvg: pairUrl ? await qrSvgFor(`${pairUrl}#${pairing.display}`) : null,
          }
        : null,
    };
  }

  return async function handle(req, res, pathname) {
    if (!guard(req, res)) return true;

    if (req.method === 'GET' && (pathname === '/mobile-gateway/manage' || pathname === '/mobile-gateway/manage/')) {
      sendHtml(res, 200, PAGE);
      return true;
    }

    if (req.method === 'GET' && pathname === '/mobile-gateway/manage/api/state') {
      sendJson(res, 200, await statePayload());
      return true;
    }

    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/mint') {
      const pairing = await store.mintPairing({
        ttlMs: config.pairingTtlMs,
        origin: String(req.headers.host ?? 'localhost'),
      });
      log.info('pairing code minted', { expiresAt: pairing.expiresAt });
      sendJson(res, 200, await statePayload());
      return true;
    }

    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/revoke') {
      const body = await readJsonBody(req);
      const ok = store.revoke(String(body.deviceId ?? ''));
      log.info(ok ? 'device revoked' : 'revoke missed', { deviceId: body.deviceId });
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { code: 'unknown_device', message: '设备不存在' } });
      return true;
    }

    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/rotate') {
      const body = await readJsonBody(req);
      const result = store.rotate(String(body.deviceId ?? ''));
      if (!result) {
        sendJson(res, 404, { error: { code: 'unknown_device', message: '设备不存在' } });
        return true;
      }
      log.info('device token rotated', { deviceId: result.device.id });
      sendJson(res, 200, { ok: true, device: result.device });
      return true;
    }

    return false;
  };
}