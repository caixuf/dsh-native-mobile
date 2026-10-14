/**
 * @file lib/manage.mjs
 * @description 仅回环可达的管理面板：铸码、二维码、设备列表与逐设备吊销。
 *
 * 配对码是**完全控制凭据**的种子，因此这一页与铸造端点一律只应答回环 TCP 对端
 * （判据是 `req.socket.remoteAddress`，不是 Host 头——本机 profile 常把 webserver
 * 绑到 0.0.0.0，用 Host 判断会被自身配置误伤）。
 */

import os from 'node:os';
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
  .qr { width:190px; height:190px; background:#fff; border-radius:10px; padding:8px; flex:0 0 auto; box-shadow:0 1px 3px rgba(0,0,0,0.06); border:1px solid var(--line); display:flex; align-items:center; justify-content:center; }
  .qr svg { width:100%; height:100%; display:block; }
  code.code { font:600 15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.02em;
             background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 10px; display:inline-block; }
  .meta { color:var(--muted); font-size:12px; margin-top:8px; }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line);
           background:var(--bg); color:var(--fg); cursor:pointer; font-weight:500; }
  button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
  button.primary:hover { background:#1d4ed8; }
  button.danger { color:#dc2626; }
  select { font:inherit; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); outline:none; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.actions { text-align:right; white-space:nowrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#9ca3af; margin-right:6px; }
  .dot.on { background:#22c55e; }
  .empty { color:var(--muted); padding:10px 0; }
  .warn { border-left:3px solid #f59e0b; padding:10px 14px; background:rgba(245,158,11,.08);
          border-radius:0 8px 8px 0; color:var(--fg); font-size:13px; }
  .tip-box { background:rgba(37,99,235,0.08); border:1px solid rgba(37,99,235,0.2); border-radius:8px; padding:10px 12px; color:var(--fg); font-size:12.5px; margin-top:12px; line-height:1.5; }
</style>
</head>
<body>
<main>
  <h1>DSH 移动网关</h1>
  <p class="sub" id="subtitle">加载中…</p>

  <section>
    <h2>扫码 / 6位数字配对码（极速连接 · 推荐）</h2>
    
    <div style="margin-bottom:14px;">
      <label style="font-size:12.5px; color:var(--muted); font-weight:500;">电脑局域网访问地址（手机同局域网/Wi-Fi）：</label>
      <div style="display:flex; gap:10px; margin-top:5px;">
        <select id="netSelect" style="flex:1;"></select>
      </div>
    </div>

    <div class="pair">
      <div class="qr" id="qr"></div>
      <div style="flex:1; min-width:240px;">
        <div id="pairArea"></div>
        <div style="margin:12px 0 8px;">
          <button class="primary" id="copyPairUrl" style="width:100%; padding:9px 14px;">一键复制手机直连配对链接</button>
        </div>
        <div class="meta" id="pairMeta"></div>
      </div>
    </div>

    <div class="tip-box">
      <strong>📱 免输网址说明：</strong>手机打开 DSH 遥控 App 点击<strong>「扫码配对」</strong>扫描上方二维码，手机端将<strong>全自动识别电脑地址并立即连接</strong>，彻底免去手动输入 IP 与端口的烦恼！
    </div>

    <p style="margin:16px 0 0">
      <button id="mint">刷新配对码</button>
      <span class="meta" style="margin-left:8px">刷新后旧码立即作废</span>
    </p>
  </section>

  <section>
    <h2>账号密码登录（备用）</h2>
    <div id="credArea"></div>
    <p style="margin:16px 0 0">
      <button class="primary" id="genCred">生成 / 重置密码</button>
      <span class="meta" style="margin-left:8px">手机上输入账号密码即可登录</span>
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

let currentSelectedBase = '';
let currentPairFullUrl = '';

async function refresh(customBase) {
  const url = '/mobile-gateway/manage/api/state' + (customBase ? '?base=' + encodeURIComponent(customBase) : '');
  const { data } = await api(url);
  if (data.error) { $('subtitle').textContent = data.error.message; return; }
  $('subtitle').textContent =
    data.instance.name + ' · 网关版本 ' + data.gatewayVersion +
    (data.channel ? ' · 在线事件流 ' + data.channel.eventSockets : '');

  // 局域网网卡下拉菜单
  if (data.lanAddresses && $('netSelect')) {
    const sel = $('netSelect');
    const selected = customBase || data.selectedBaseUrl;
    currentSelectedBase = selected;
    const options = data.lanAddresses.map((a) => {
      const isSel = a.url === selected ? ' selected' : '';
      return '<option value="' + a.url + '"' + isSel + '>' +
        a.name + ' (' + a.ip + ') ' + (a.isVirtual ? '[虚拟网卡]' : '[推荐·局域网]') +
        '</option>';
    });
    options.push('<option value="custom"' + (data.isCustomBase ? ' selected' : '') + '>自定义公网/穿透域名…</option>');
    sel.innerHTML = options.join('');
  }

  const pair = data.pairing;
  if (pair) {
    currentPairFullUrl = pair.pairFullUrl || '';
    const pinHtml = pair.pinDisplay
      ? '<div style="font-size:28px; font-weight:700; letter-spacing:4px; font-family:ui-monospace,SFMono-Regular,monospace; color:#2563eb; margin-bottom:4px;">' + pair.pinDisplay + '</div>' +
        '<div class="meta" style="margin-bottom:8px;">手机输入 6 位数或扫码均可</div>'
      : '';
    $('pairArea').innerHTML = pinHtml + '<code class="code" style="font-size:12px; color:var(--muted);">' + pair.display + '</code>';
    $('qr').innerHTML = pair.qrSvg || '<div class="meta">生成二维码中…</div>';
    $('pairMeta').textContent =
      '有效期至 ' + fmtTime(pair.expiresAt) + ' · 直连主机：' + (pair.pairBaseUrl || '自动识别');
  } else {
    currentPairFullUrl = '';
    $('pairArea').innerHTML = '<span class="meta">当前没有有效配对码</span>';
    $('qr').innerHTML = '<div class="meta">暂无配对码</div>';
    $('pairMeta').textContent = '点击「刷新配对码」生成一枚新的';
  }

  // 账号密码卡片
  const cred = data.credentials;
  if (!cred) {
    $('credArea').innerHTML = '<div class="empty">还没设置。点下面的按钮生成。</div>';
  } else {
    const shown = freshPassword
      ? '<div style="margin:8px 0"><span class="meta">密码（只显示这一次，请记下）</span><br>' +
        '<code class="code" id="credPw">' + freshPassword + '</code> ' +
        '<button data-act="copy-pw">复制</button></div>'
      : '<div class="meta" style="margin:8px 0">密码已设置。忘记就点「生成 / 重置密码」换一个新的。</div>';
    $('credArea').innerHTML =
      '<div class="pair"><div style="flex:1">' +
      '<div><span class="meta">账号</span><br><code class="code">' + cred.username + '</code></div>' +
      shown +
      '<div class="meta">创建于 ' + fmtTime(cred.createdAt) + '</div>' +
      '</div></div>';
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

/** 刚生成的密码明文 —— 只在本次生成后显示，刷新即消失 */
let freshPassword = null;

$('netSelect')?.addEventListener('change', async (ev) => {
  const val = ev.target.value;
  if (val === 'custom') {
    const input = prompt('请输入你的公网域名或局域网 IP（例如 http://192.168.31.79:19387 或 https://dsh.example.com）：', currentSelectedBase || 'http://');
    if (input && input.startsWith('http')) {
      currentSelectedBase = input.trim().replace(/\\/+$/, '');
      await refresh(currentSelectedBase);
    } else {
      await refresh();
    }
  } else {
    currentSelectedBase = val;
    await refresh(currentSelectedBase);
  }
});

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'mint') {
    btn.disabled = true;
    await api('/mobile-gateway/manage/api/mint', {});
    btn.disabled = false;
    await refresh(currentSelectedBase);
    return;
  }
  if (btn.id === 'copyPairUrl') {
    if (currentPairFullUrl) {
      try {
        await navigator.clipboard.writeText(currentPairFullUrl);
        btn.textContent = '已复制！可直接发送到手机或输入法粘贴';
        setTimeout(() => { btn.textContent = '一键复制手机直连配对链接'; }, 2000);
      } catch {
        prompt('请复制以下配对链接：', currentPairFullUrl);
      }
    }
    return;
  }
  // 生成 / 重置密码
  if (btn.id === 'genCred') {
    if (!confirm('重置后旧密码立即失效，手机上需要重新登录。确定？')) return;
    btn.disabled = true;
    const r = await api('/mobile-gateway/manage/api/credentials', { action: 'regenerate' });
    btn.disabled = false;
    if (r.data?.password) {
      freshPassword = r.data.password;
    }
    await refresh(currentSelectedBase);
    return;
  }
  // 复制密码到剪贴板
  if (btn.dataset.act === 'copy-pw') {
    const el = $('credPw');
    if (el) {
      try {
        await navigator.clipboard.writeText(el.textContent);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      } catch {
        btn.textContent = '复制失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }
    }
    return;
  }
  const act = btn.dataset.act;
  if (!act) return;
  if (act === 'revoke' && !confirm('吊销后该设备需要重新配对，确定？')) return;
  btn.disabled = true;
  await api('/mobile-gateway/manage/api/' + act, { deviceId: btn.dataset.id });
  btn.disabled = false;
  await refresh(currentSelectedBase);
});

refresh();
setInterval(() => refresh(currentSelectedBase), 5000);
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

  function extractPort(req) {
    const host = req?.headers?.host || '';
    if (host.includes(':')) return host.split(':')[1];
    return '19387';
  }

  function getLanCandidates(port) {
    const interfaces = os.networkInterfaces();
    const list = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const isVirtual = /wsl|vEthernet|vmnet|docker|hyper-v|tailscale|loopback/i.test(name);
          list.push({
            name,
            ip: addr.address,
            url: `http://${addr.address}:${port}`,
            isVirtual,
          });
        }
      }
    }
    // 物理局域网排在前面
    list.sort((a, b) => (a.isVirtual === b.isVirtual ? 0 : a.isVirtual ? 1 : -1));
    return list;
  }

  function resolvePairBase(req, overrideBase) {
    if (overrideBase && overrideBase.trim()) {
      return overrideBase.trim().replace(/\/+$/, '');
    }
    if (config.publicBaseUrl && config.publicBaseUrl.trim()) {
      return config.publicBaseUrl.trim().replace(/\/+$/, '');
    }
    const port = extractPort(req);
    const lans = getLanCandidates(port);
    if (lans.length > 0) {
      return lans[0].url;
    }
    return `http://${req?.headers?.host || '127.0.0.1:' + port}`;
  }

  function guard(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendError(res, 403, 'loopback_only', '管理面只应答回环来源');
      return false;
    }
    return true;
  }

  async function statePayload(req, overrideBase) {
    const pairing = store.currentPairing();
    const port = extractPort(req);
    const lanAddresses = getLanCandidates(port);
    const selectedBaseUrl = resolvePairBase(req, overrideBase);
    const pairUrl = `${selectedBaseUrl}/mobile-gateway/pair`;
    const pairFullUrl = pairing ? `${pairUrl}#${pairing.display}` : null;
    const credentials = store.credentialsView();

    let qrSvg = null;
    if (pairFullUrl) {
      qrSvg = await qrSvgFor(pairFullUrl);
    } else if (pairing) {
      qrSvg = await qrSvgFor(pairing.display);
    }

    return {
      gatewayVersion,
      instance,
      devices: store.list(),
      channel: describeChannel?.() ?? null,
      credentials,
      lanAddresses,
      selectedBaseUrl,
      isCustomBase: Boolean(overrideBase && overrideBase.trim()),
      pairing: pairing
        ? {
            ...pairing,
            pairUrl,
            pairBaseUrl: selectedBaseUrl,
            pairFullUrl,
            qrSvg,
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
      const parsedUrl = new URL(req.url, 'http://localhost');
      const customBase = parsedUrl.searchParams.get('base');
      sendJson(res, 200, await statePayload(req, customBase));
      return true;
    }

    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/mint') {
      const pairing = await store.mintPairing({
        ttlMs: config.pairingTtlMs,
        origin: String(req.headers.host ?? 'localhost'),
      });
      log.info('pairing code minted', { expiresAt: pairing.expiresAt });
      const parsedUrl = new URL(req.url, 'http://localhost');
      const customBase = parsedUrl.searchParams.get('base');
      sendJson(res, 200, await statePayload(req, customBase));
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

    // 按 platform+name 合并重复设备（清理历史遗留）
    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/dedupe') {
      const result = await store.dedupeDevices();
      log.info('devices deduped', result);
      sendJson(res, 200, await statePayload(req, new URL(req.url, 'http://localhost').searchParams.get('base')));
      return true;
    }

    // 清空所有设备（保留账号凭据）。
    // ⚠️ 所有已配对设备会立刻掉线，需重新登录/配对。
    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/clear-devices') {
      const result = await store.clearDevices();
      log.info('all devices cleared', result);
      sendJson(res, 200, await statePayload(req, new URL(req.url, 'http://localhost').searchParams.get('base')));
      return true;
    }

    // 生成 / 重置密码。明文只在**这一次响应**里返回
    if (req.method === 'POST' && pathname === '/mobile-gateway/manage/api/credentials') {
      const body = await readJsonBody(req);
      const action = String(body.action ?? 'regenerate');
      if (action !== 'regenerate') {
        sendError(res, 400, 'bad_action', `未知动作 ${action}`);
        return true;
      }
      const { randomBytes } = await import('node:crypto');
      const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      const bytes = randomBytes(12);
      let password = '';
      for (let i = 0; i < 12; i += 1) password += ALPHABET[bytes[i] % ALPHABET.length];
      const result = await store.setPassword(password);
      if (!result.ok) {
        sendError(res, 400, result.reason, '重置失败');
        return true;
      }
      log.warn('credentials regenerated — 旧密码已失效');
      sendJson(res, 200, { ok: true, username: store.credentialsView()?.username, password });
      return true;
    }

    return false;
  };
}