// ==UserScript==
// @name         Slack User Icon Downloader
// @namespace    slack-user-icon-downloader
// @version      2.4.0
// @description  ワークスペースのメンバーのアイコンを元画像で取得し、選択したユーザーを「氏名_表示名.拡張子」で ZIP ダウンロード
// @author       Seiya Funaoka
// @license      MIT
// @homepageURL  https://github.com/SeiyaFunaokaJP/slack-user-icon-downloader
// @downloadURL  https://github.com/SeiyaFunaokaJP/slack-user-icon-downloader/raw/refs/heads/main/slack-icon-downloader.user.js
// @updateURL    https://github.com/SeiyaFunaokaJP/slack-user-icon-downloader/raw/refs/heads/main/slack-icon-downloader.user.js
// @match        https://app.slack.com/*
// @grant        GM_xmlhttpRequest
// @connect      slack-edge.com
// @connect      gravatar.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- 設定 (モーダルで変更。保存はせず、ページを開くたびにこの既定値から始まる) ----
  const DEFAULTS = {
    includeDeactivated: false, // 退会済みユーザーも含める
    includeBots: false,        // Bot も含める
    skipDefaultAvatar: true,   // デフォルトアイコンの人は除外
    pageSize: 20,              // 1ページの表示人数
    concurrency: 2,            // 同時ダウンロード数
    // 画像リクエストの最小間隔(秒)。全体で共有するので並列数に関係なく最大 1/interval 件/秒。
    // 0.5秒 = 2件/秒。Slack 画面をスクロールした時に一度に数十枚読む通常利用より十分穏やか。
    interval: 0.5,
  };
  // v2.2 以前が保存していた設定を掃除
  try { localStorage.removeItem('slackIconDL_settings'); } catch (_) { /* 無視 */ }

  // ---- セッショントークン取得 (Slack Web クライアントが localStorage に保持しているもの) ----
  function getTeam() {
    const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
    const teams = cfg.teams || {};
    const m = location.pathname.match(/\/client\/([TE][A-Z0-9]+)/);
    const id = (m && teams[m[1]]) ? m[1] : cfg.lastActiveTeamId;
    const team = teams[id];
    if (!team || !team.token) throw new Error('トークンが見つかりません。Slack にログインした状態で開いてください。');
    return { id, token: team.token, name: team.name || id };
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: 30000,
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error('network error: ' + opts.url)),
        ontimeout: () => reject(new Error('timeout: ' + opts.url)),
      });
    });
  }

  // app.slack.com の同一オリジン /api/ に multipart で投げる (Slack クライアントと同じ方式)
  async function api(team, method, params) {
    const body = new FormData();
    body.append('token', team.token);
    for (const [k, v] of Object.entries(params)) body.append(k, v);
    const res = await fetch(`/api/${method}`, { method: 'POST', body, credentials: 'include' });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '5', 10) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return api(team, method, params);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.error}`);
    return json;
  }

  async function fetchAllUsers(team, onProgress) {
    const users = [];
    let cursor = '';
    do {
      const r = await api(team, 'users.list', { limit: '200', cursor });
      users.push(...r.members);
      onProgress(users.length);
      cursor = r.response_metadata?.next_cursor || '';
    } while (cursor);
    return users;
  }

  // ---- 画像 URL 候補 (高画質順) ----
  function imageCandidates(p) {
    const list = [];
    if (p.image_original) list.push(p.image_original); // カスタム画像ならアップロード元画像
    for (const k of ['image_1024', 'image_512', 'image_192', 'image_72']) if (p[k]) list.push(p[k]);
    // Gravatar は s= を大きく
    return [...new Set(list)].map(u => u.includes('gravatar.com') ? u.replace(/([?&])s=\d+/, '$1s=2048') : u);
  }

  function extFromType(type, url) {
    if (/png/i.test(type)) return 'png';
    if (/gif/i.test(type)) return 'gif';
    if (/webp/i.test(type)) return 'webp';
    if (/jpe?g/i.test(type)) return 'jpg';
    const m = url.match(/\.(jpe?g|png|gif|webp)(?:$|\?)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  // ---- 画像リクエストの間隔制御 (全ワーカー共通) ----
  const MIN_INTERVAL = 0.2; // これより短くはさせない (5件/秒)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let nextSlot = 0;
  async function throttle(intervalSec) {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + Math.max(MIN_INTERVAL, intervalSec) * 1000;
    if (at > now) await sleep(at - now);
  }
  // 429/5xx が返ったら全体を一時停止する
  function backoff(res) {
    const sec = parseInt(res.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || '30', 10);
    nextSlot = Math.max(nextSlot, Date.now() + sec * 1000);
    return sec;
  }

  async function downloadBest(p, intervalSec, onWait) {
    for (const url of imageCandidates(p)) {
      try {
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          await throttle(intervalSec);
          res = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer' });
          if (res.status !== 429 && res.status < 500) break;
          onWait(backoff(res));
        }
        if (res.status === 200 && res.response && res.response.byteLength > 0) {
          const type = res.responseHeaders.match(/content-type:\s*([^\r\n;]+)/i)?.[1] || '';
          if (type && !type.startsWith('image/')) continue;
          return { data: res.response, ext: extFromType(type, url), url };
        }
      } catch (_) { /* 次の候補へ */ }
    }
    return null;
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+$/, '').replace(/^\.+/, '_').slice(0, 120) || 'unknown';
  }

  // ---- 無圧縮 ZIP 作成 (画像は圧縮済みなので STORE で十分。JSZip は Tampermonkey 内で generateAsync が止まることがあるため自前) ----
  // ZIP-BEGIN
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // files: [{ name: string, data: Uint8Array }] → Blob
  function buildZip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 ファイル名
      local.setUint16(8, 0, true);      // STORE
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, f.data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  // ZIP-END

  function toRow(u) {
    const p = u.profile || {};
    const display = p.display_name || p.real_name || u.real_name || u.name || u.id;
    const realName = p.real_name || u.real_name || '';
    // 「氏名_表示名」。どちらかが空、または同じなら片方だけ
    const fileName = realName && p.display_name && realName !== p.display_name
      ? `${realName}_${p.display_name}` : (realName || display);
    return {
      id: u.id,
      display,
      realName,
      baseName: sanitize(fileName),
      source: p.image_original ? 'オリジナル' : (p.is_custom_image ? '1024以下' : 'デフォルト'),
      status: [u.deleted && '退会', u.is_bot && 'Bot'].filter(Boolean).join(' / '),
      deleted: !!u.deleted,
      bot: !!u.is_bot,
      custom: !!p.is_custom_image,
      profile: p,
    };
  }

  // ---- UI ----
  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
    .modal { width: min(920px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: #fff; color: #1d1c1d; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.35); font-size: 13px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #e5e5e5; }
    header h2 { margin: 0; font-size: 16px; }
    .x { background: none; border: none; font-size: 20px; cursor: pointer; color: #616061; line-height: 1; }
    .settings { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: 12px 18px; border-bottom: 1px solid #e5e5e5; background: #f8f8f8; }
    .settings label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
    .settings select, .settings input[type=number] { font-size: 13px; padding: 2px 4px; }
    .settings input[type=number] { width: 52px; }
    .body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0 18px; min-height: 120px; }
    .empty { color: #616061; padding: 40px 0; text-align: center; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    th { position: sticky; top: 0; background: #fff; font-weight: 600; color: #616061; z-index: 1; }
    td.c, th.c { width: 36px; text-align: center; }
    th.n { width: 52px; } th.src { width: 92px; } th.st { width: 76px; }
    tr:hover td { background: #f6f6f6; }
    .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eee; }
    .tag.orig { background: #e3f4ea; color: #007a5a; }
    .tag.def { background: #fdecea; color: #b01d1d; }
    .muted { color: #8a8a8a; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 18px; border-top: 1px solid #e5e5e5; flex-wrap: wrap; }
    .pager { display: flex; align-items: center; gap: 6px; }
    .pageNo { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 18px; border-top: 1px solid #e5e5e5; }
    .status { color: #616061; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.btn { font-size: 13px; padding: 6px 12px; border-radius: 6px; border: 1px solid #bbb; background: #fff; cursor: pointer; }
    button.btn:hover:not(:disabled) { background: #f2f2f2; }
    button.primary { background: #007a5a; border-color: #007a5a; color: #fff; }
    button.primary:hover:not(:disabled) { background: #148567; }
    button:disabled { opacity: .45; cursor: default; }
    @media (prefers-color-scheme: dark) {
      .modal { background: #1a1d21; color: #d1d2d3; }
      header, .settings, .bar, footer, th, td { border-color: #35373b; }
      .settings { background: #222529; }
      th { background: #1a1d21; color: #ababad; }
      tr:hover td { background: #222529; }
      .tag { background: #35373b; }
      .tag.orig { background: #0f3b2e; color: #6fd3a8; }
      .tag.def { background: #4a1d1d; color: #f59a9a; }
      button.btn { background: #222529; color: #d1d2d3; border-color: #565856; }
      button.btn:hover:not(:disabled) { background: #2c2f33; }
      button.primary { background: #007a5a; color: #fff; border-color: #007a5a; }
      .x, .status, .empty { color: #ababad; }
    }
  `;

  const state = {
    settings: { ...DEFAULTS },
    team: null,
    rawUsers: null,   // users.list の結果 (取得済みなら設定変更時は再取得せず再フィルタ)
    rows: [],         // 設定の条件に合ったユーザー
    selected: new Set(),
    page: 1,
    busy: false,
    cancel: false,
  };

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <div class="backdrop" id="backdrop" hidden>
      <div class="modal" role="dialog" aria-label="Slack アイコンダウンロード">
        <header><h2>Slack アイコンダウンロード</h2><button class="x" id="close" title="閉じる">×</button></header>
        <div class="settings">
          <label><input type="checkbox" id="s-skipDefault"> デフォルトアイコンを除外</label>
          <label><input type="checkbox" id="s-deact"> 退会済みを含める</label>
          <label><input type="checkbox" id="s-bots"> Bot を含める</label>
          <label>1ページ <select id="s-pageSize"><option>10</option><option>20</option><option>50</option><option>100</option></select> 人</label>
          <label>同時DL <input type="number" id="s-conc" min="1" max="4"></label>
          <label>間隔 <input type="number" id="s-interval" min="0.2" max="10" step="0.1"> 秒</label>
          <button class="btn primary" id="fetch">ユーザー一覧を取得</button>
        </div>
        <div class="body" id="body"><div class="empty">「ユーザー一覧を取得」を押してください</div></div>
        <div class="bar">
          <div>
            <button class="btn" id="selAll">すべて選択</button>
            <button class="btn" id="selNone">すべて解除</button>
            <span class="muted" id="selCount"></span>
          </div>
          <div class="pager">
            <button class="btn" id="prev">&lt;</button>
            <span class="pageNo"><span id="pageCur">1</span> / <span id="pageTotal">1</span></span>
            <button class="btn" id="next">&gt;</button>
          </div>
        </div>
        <footer>
          <div class="status" id="status"></div>
          <button class="btn" id="cancel" hidden>中止</button>
          <button class="btn primary" id="download" disabled>ダウンロード開始</button>
        </footer>
      </div>
    </div>`;
  const $ = (id) => root.getElementById(id);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setStatus(t) { $('status').textContent = t; }

  function syncSettingsUI() {
    const s = state.settings;
    $('s-skipDefault').checked = s.skipDefaultAvatar;
    $('s-deact').checked = s.includeDeactivated;
    $('s-bots').checked = s.includeBots;
    $('s-pageSize').value = String(s.pageSize);
    $('s-conc').value = String(s.concurrency);
    $('s-interval').value = String(s.interval);
  }

  function readSettingsUI() {
    const s = state.settings;
    s.skipDefaultAvatar = $('s-skipDefault').checked;
    s.includeDeactivated = $('s-deact').checked;
    s.includeBots = $('s-bots').checked;
    s.pageSize = parseInt($('s-pageSize').value, 10) || 20;
    s.concurrency = Math.min(4, Math.max(1, parseInt($('s-conc').value, 10) || DEFAULTS.concurrency));
    const iv = parseFloat($('s-interval').value);
    s.interval = Math.min(10, Math.max(MIN_INTERVAL, Number.isFinite(iv) ? iv : DEFAULTS.interval));
    $('s-conc').value = String(s.concurrency);
    $('s-interval').value = String(s.interval);
  }

  function applyFilter() {
    if (!state.rawUsers) return;
    const s = state.settings;
    state.rows = state.rawUsers
      .filter(u => u.id !== 'USLACKBOT')
      .map(toRow)
      .filter(r =>
        (s.includeDeactivated || !r.deleted) &&
        (s.includeBots || !r.bot) &&
        (!s.skipDefaultAvatar || r.custom)
      );
    const ids = new Set(state.rows.map(r => r.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    state.page = Math.min(state.page, totalPages());
    render();
  }

  function totalPages() { return Math.max(1, Math.ceil(state.rows.length / state.settings.pageSize)); }

  function render() {
    const total = totalPages();
    $('pageTotal').textContent = total;
    $('pageCur').textContent = state.page;
    $('prev').disabled = state.busy || state.page <= 1;
    $('next').disabled = state.busy || state.page >= total;
    $('selCount').textContent = state.rawUsers ? `選択 ${state.selected.size} / ${state.rows.length} 人` : '';
    $('download').disabled = state.busy || state.selected.size === 0;
    for (const id of ['fetch', 'selAll', 'selNone', 's-skipDefault', 's-deact', 's-bots', 's-pageSize', 's-conc', 's-interval']) $(id).disabled = state.busy;
    $('cancel').hidden = !state.busy;

    if (!state.rawUsers) return;
    if (!state.rows.length) { $('body').innerHTML = '<div class="empty">条件に合うユーザーがいません</div>'; return; }

    const start = (state.page - 1) * state.settings.pageSize;
    const pageRows = state.rows.slice(start, start + state.settings.pageSize);
    const allOnPage = pageRows.every(r => state.selected.has(r.id));
    const tagClass = (src) => src === 'オリジナル' ? 'orig' : (src === 'デフォルト' ? 'def' : '');
    $('body').innerHTML = `<table>
      <thead><tr>
        <th class="c"><input type="checkbox" id="pageAll" title="このページをすべて選択" ${allOnPage ? 'checked' : ''} ${state.busy ? 'disabled' : ''}></th>
        <th class="n">#</th><th>表示名</th><th>氏名</th><th>保存ファイル名</th><th class="src">画像</th><th class="st">状態</th>
      </tr></thead>
      <tbody>${pageRows.map((r, i) => `<tr>
        <td class="c"><input type="checkbox" data-id="${r.id}" ${state.selected.has(r.id) ? 'checked' : ''} ${state.busy ? 'disabled' : ''}></td>
        <td class="muted">${start + i + 1}</td>
        <td title="${escapeHtml(r.display)}">${escapeHtml(r.display)}</td>
        <td class="muted" title="${escapeHtml(r.realName)}">${escapeHtml(r.realName)}</td>
        <td title="${escapeHtml(r.baseName)}">${escapeHtml(r.baseName)}.*</td>
        <td><span class="tag ${tagClass(r.source)}">${r.source}</span></td>
        <td class="muted">${r.status}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  async function onFetch() {
    readSettingsUI();
    state.busy = true; render();
    try {
      state.team = getTeam();
      setStatus('ユーザー一覧取得中...');
      state.rawUsers = await fetchAllUsers(state.team, n => setStatus(`ユーザー一覧取得中... ${n} 人`));
      state.selected.clear();
      state.page = 1;
      state.busy = false;
      applyFilter();
      setStatus(`${state.team.name}: 全 ${state.rawUsers.length} 人中 ${state.rows.length} 人が条件に一致`);
    } catch (e) {
      console.error('[SlackIconDL]', e);
      setStatus('エラー: ' + e.message);
    } finally {
      state.busy = false; render();
    }
  }

  async function onDownload() {
    readSettingsUI();
    const targets = state.rows.filter(r => state.selected.has(r.id));
    if (!targets.length) return;
    state.busy = true; state.cancel = false; render();
    try {
      const files = [];
      const usedNames = new Map();
      const failed = [];
      const index = [['file', 'user_id', 'display_name', 'real_name', 'source_url']];
      let done = 0;
      const interval = state.settings.interval;
      const fmtEta = (n) => { const s = Math.ceil(n * interval); return s >= 60 ? `約${Math.ceil(s / 60)}分` : `約${s}秒`; };
      const onWait = (sec) => setStatus(`サーバーから待機要求 (429/5xx)。${sec}秒休止してから再開します...`);
      setStatus(`ダウンロード開始... 0 / ${targets.length} (残り${fmtEta(targets.length)})`);

      nextSlot = 0;
      const queue = targets.slice();
      async function worker() {
        while (queue.length && !state.cancel) {
          const r = queue.shift();
          const img = await downloadBest(r.profile, interval, onWait);
          done++;
          setStatus(`ダウンロード中... ${done} / ${targets.length} (残り${fmtEta(targets.length - done)})`);
          if (!img) { failed.push(`${r.display} (${r.id})`); continue; }

          let base = r.baseName;
          const key = `${base}.${img.ext}`.toLowerCase();
          const n = (usedNames.get(key) || 0) + 1;
          usedNames.set(key, n);
          if (n > 1) base = `${base} (${r.id})`; // 同名は ID を付けて区別
          const file = `${base}.${img.ext}`;
          files.push({ name: file, data: new Uint8Array(img.data) });
          index.push([file, r.id, r.profile.display_name || '', r.realName, img.url]);
        }
      }
      await Promise.all(Array.from({ length: state.settings.concurrency }, worker));
      if (state.cancel) { setStatus(`中止しました (${done} / ${targets.length} 取得済み、保存はしていません)`); return; }

      const csv = index.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const enc = new TextEncoder();
      files.push({ name: '_index.csv', data: enc.encode('﻿' + csv) });
      if (failed.length) files.push({ name: '_failed.txt', data: enc.encode(failed.join('\r\n')) });

      setStatus('ZIP 作成中...');
      const blob = buildZip(files);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `slack-icons_${sanitize(state.team.name)}_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);

      setStatus(`完了: ${index.length - 1} 件保存${failed.length ? ` / 失敗 ${failed.length} 件 (_failed.txt 参照)` : ''}`);
    } catch (e) {
      console.error('[SlackIconDL]', e);
      setStatus('エラー: ' + e.message);
    } finally {
      state.busy = false; render();
    }
  }

  function goPage(p) {
    state.page = Math.min(totalPages(), Math.max(1, p || 1));
    render();
  }

  function openModal() { syncSettingsUI(); render(); $('backdrop').hidden = false; }
  function closeModal() { if (!state.busy) $('backdrop').hidden = true; }

  $('close').addEventListener('click', closeModal);
  $('backdrop').addEventListener('click', (e) => { if (e.target === $('backdrop')) closeModal(); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); e.stopPropagation(); });
  $('fetch').addEventListener('click', onFetch);
  $('download').addEventListener('click', onDownload);
  $('cancel').addEventListener('click', () => { state.cancel = true; setStatus('中止しています...'); });
  $('prev').addEventListener('click', () => goPage(state.page - 1));
  $('next').addEventListener('click', () => goPage(state.page + 1));
  $('selAll').addEventListener('click', () => { state.rows.forEach(r => state.selected.add(r.id)); render(); });
  $('selNone').addEventListener('click', () => { state.selected.clear(); render(); });

  // フィルタ系の設定は取得済みリストに即反映 (再取得しない)
  for (const id of ['s-skipDefault', 's-deact', 's-bots', 's-pageSize']) {
    $(id).addEventListener('change', () => { readSettingsUI(); state.page = 1; applyFilter(); render(); });
  }
  $('s-conc').addEventListener('change', readSettingsUI);
  $('s-interval').addEventListener('change', readSettingsUI);

  $('body').addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'pageAll') {
      const start = (state.page - 1) * state.settings.pageSize;
      for (const r of state.rows.slice(start, start + state.settings.pageSize)) {
        t.checked ? state.selected.add(r.id) : state.selected.delete(r.id);
      }
      render();
    } else if (t.dataset && t.dataset.id) {
      t.checked ? state.selected.add(t.dataset.id) : state.selected.delete(t.dataset.id);
      render();
    }
  });

  document.body.appendChild(host);

  // ---- 起動ボタン: Slack 上部ヘッダー右側 (ヘルプボタンの左) に置く ----
  const NAV_BTN_ID = 'slack-icon-dl-navbtn';
  function makeNavButton() {
    const b = document.createElement('button');
    b.id = NAV_BTN_ID;
    b.type = 'button';
    b.title = 'アイコン一括ダウンロード';
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>アイコンDL</span>';
    Object.assign(b.style, {
      display: 'inline-flex', alignItems: 'center', gap: '5px', height: '26px', padding: '0 9px', margin: '0 8px 0 0',
      border: '1px solid rgba(255,255,255,.35)', borderRadius: '6px', background: 'transparent',
      color: 'rgba(255,255,255,.9)', font: '600 12px/1 -apple-system, "Segoe UI", sans-serif', cursor: 'pointer', flexShrink: '0',
    });
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.15)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', openModal);
    return b;
  }
  function placeNavButton() {
    if (document.getElementById(NAV_BTN_ID)) return;
    const right = document.querySelector('[data-qa="top-nav"] .p-ia4_top_nav__right_container, .p-ia4_top_nav__right_container');
    if (!right) return;
    // ヘルプボタンを含む right 直下の要素の手前に入れる (無ければ末尾)
    let anchor = right.querySelector('[data-qa="top-nav-help-button"]');
    while (anchor && anchor.parentElement !== right) anchor = anchor.parentElement;
    right.insertBefore(makeNavButton(), anchor || null);
    right.style.alignItems = 'center';
  }
  // Slack は SPA でヘッダーを再描画するので、消えたら置き直す
  new MutationObserver(placeNavButton).observe(document.body, { childList: true, subtree: true });
  placeNavButton();
})();
