/* ═══════════════════════════════════════════════════════════════════════════
   数据实时性与血缘（data-source freshness）
   ───────────────────────────────────────────────────────────────────────────
   回答两个问题：① 这块数据到底从哪来、可不可信；② 现在看到的是不是最新的。
   做法：
     · /api/provenance 给出每一层的来源、分辨率、更新节律、文件时间与陈旧判定；
     · /api/data/version 给一个轻量指纹，前端 20 秒轮询一次，只有变了才重新拉数，
       避免「每 30 秒整页重绘」的闪烁，也避免无谓请求；
     · GEE 时序属于批处理产物，这里显式标出「批次时间 + 覆盖区间 + 是否需增量同步」。
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function q(id) { return document.getElementById(id); }
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  var DS = { token: null, timer: null, last: null, interval: 20 };

  var CSS = ''
    + '.ds-live{margin-bottom:10px}'
    + '.ds-sum{display:flex;gap:5px;margin-bottom:6px;flex-wrap:wrap}'
    + '.ds-sum span{font-size:9.5px;padding:2px 7px;border-radius:9px;font-family:Consolas,monospace;'
    + 'background:rgba(53,224,184,.1);border:1px solid rgba(53,224,184,.32);color:#7fe3cd}'
    + '.ds-sum span.bad{background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.32);color:#ffa8a8}'
    + '.ds-sum span.warn{background:rgba(240,180,76,.1);border-color:rgba(240,180,76,.32);color:#ffd48a}'
    + '.ds-row{display:flex;align-items:flex-start;gap:7px;padding:5px 7px;border-radius:5px;'
    + 'background:rgba(13,30,38,.62);margin-bottom:3px;border-left:3px solid var(--acc)}'
    + '.ds-row.warn{border-left-color:#f2c94c}'
    + '.ds-row.bad{border-left-color:#ff6b6b}'
    + '.ds-row .nm{flex:1;min-width:0}'
    + '.ds-row .nm b{font-size:11px;color:#e6f6f4;font-weight:500}'
    + '.ds-row .nm .s{font-size:9px;color:#7d979b;line-height:1.55;margin-top:1px}'
    + '.ds-row .rt{flex:0 0 62px;text-align:right;font-family:Consolas,monospace;font-size:9px;color:#9fb8bb}'
    + '.ds-row .rt b{display:block;font-size:10px;color:#bfe6dc}'
    + '.ds-pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:#35e0b8;'
    + 'box-shadow:0 0 8px #35e0b8;margin-right:4px;animation:dsPulse 2s infinite}'
    + '@keyframes dsPulse{0%,100%{opacity:1}50%{opacity:.25}}';

  (function () {
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  })();

  function statusOf(it) {
    if (it.status === 'missing') return ['bad', '缺失'];
    if (it.status === 'stale') return ['warn', '陈旧'];
    return ['', '正常'];
  }

  function render(pv, rs) {
    var box = q('dsLive');
    if (!box) return;
    var h = '<div id="dsConc"></div>';
    window.dhFetch('/api/conclusion', 9000).then(function (j) {
      var box = q('dsConc');
      if (!box || !j || !j.ok) return;
      var k = j.kpi;
      box.innerHTML = '<div class="sec-lab">流域生态态势 · 结论</div>'
        + '<div style="background:linear-gradient(135deg,rgba(53,224,184,.10),rgba(53,224,184,.03));'
        + 'border:1px solid rgba(53,224,184,.28);border-radius:8px;padding:9px 10px;margin-bottom:8px">'
        + '<div style="display:flex;gap:12px;align-items:baseline;margin-bottom:5px">'
        + '<span style="font-family:Consolas,monospace;font-size:22px;color:#7fe3cd">' + Number(k.eei).toFixed(1) + '</span>'
        + '<span style="font-size:10px;color:#9fb8bb">EEI · ' + k.grade + ' 级</span>'
        + '<span style="margin-left:auto;font-size:9.5px;color:#ffd48a">高风险 ' + k.high + ' 站</span></div>'
        + '<div style="font-size:10.5px;line-height:1.85;color:#cfe9e2">' + E(j.text) + '</div>'
        + '<div style="font-size:8.5px;color:#6f8f96;margin-top:5px;font-family:Consolas,monospace">'
        + 'A 实测 ' + ((j.confidence || {}).A || 0) + ' · B 模型 ' + ((j.confidence || {}).B || 0)
        + ' · C 遥感 ' + ((j.confidence || {}).C || 0) + ' · D 代理 ' + ((j.confidence || {}).D || 0)
        + ' ｜ 指纹 ' + E(j.dataToken) + '</div>'
        + '<div class="hx-go2" style="cursor:pointer;font-size:9px;color:#7fe3cd;margin-top:5px">'
        + '展开态势总览 →</div></div>';
      var g2 = box.querySelector('.hx-go2');
      if (g2) g2.onclick = function () { if (window.switchModule) window.switchModule('home'); };
    }).catch(function () {});
    h += '<div class="sec-lab">数据实时性 · 来源与新鲜度</div>';
    var s = pv.summary || {};
    h += '<div class="ds-sum">'
      + '<span>正常 ' + (s.ok || 0) + '</span>'
      + (s.stale ? '<span class="warn">陈旧 ' + s.stale + '</span>' : '')
      + (s.missing ? '<span class="bad">缺失 ' + s.missing + '</span>' : '')
      + '<span title="数据指纹：人工修正/站点表/气候/遥感批次任一变化都会变">#' + E(DS.token || '—') + '</span>'
      + '<span>检查 ' + new Date().toTimeString().slice(0, 8) + '</span></div>';

    (pv.items || []).forEach(function (it) {
      var st = statusOf(it);
      var tip = E(it.kind) + ' · ' + E(it.src) + ' · ' + E(it.res);
      h += '<div class="ds-row ' + st[0] + '" title="' + tip + '">'
        + '<div class="nm"><b>' + E(it.nm) + '</b>'
        + '<div class="s">' + E(it.kind) + ' ｜ ' + E(it.res) + '<br>' + E(it.src)
        + (it.coverage ? '<br>覆盖 ' + E(it.coverage) : '')
        + (it.note ? '<br><span style="color:#6f8f96">' + E(it.note) + '</span>' : '') + '</div></div>'
        + '<div class="rt"><b style="color:' + (st[0] === 'bad' ? '#ffa8a8' : st[0] === 'warn' ? '#ffd48a' : '#7fe3cd')
        + '">' + st[1] + '</b>' + E(it.updated ? it.updated.slice(5) : '—')
        + (it.ageDays != null ? '<br>' + it.ageDays + ' 天前' : '') + '</div></div>';
    });

    /* 交叉验证 */
    h += '<div class="sec-lab" style="margin-top:9px">交叉验证 · 独立数据源比对</div>';
    h += '<div id="dsVal"><div class="mod-note" style="font-size:9.5px">读取中…</div></div>';

    /* 数据库（真实入库） */
    h += '<div class="sec-lab" style="margin-top:9px">数据库 · PostgreSQL jinsha</div>';
    h += '<div id="dsPg"><div class="mod-note" style="font-size:9.5px">读取中…</div></div>';

    /* GEE 批次状态 */
    h += '<div class="sec-lab" style="margin-top:9px">遥感时序（GEE 批处理）</div>';
    if (rs && rs.available) {
      h += '<div class="mod-note" style="font-size:9.5px">批次 <b>' + E(rs.meta.version || '')
        + '</b> · 更新于 ' + E((rs.meta.updated || '').slice(0, 16))
        + ' · 采样窗口 ±' + (rs.meta.radius_m || 1000) + ' m</div>';
      (rs.metrics || []).forEach(function (m) {
        h += '<div class="ds-row"><div class="nm"><b>' + E(m.name) + '</b>'
          + '<div class="s">' + E(m.collection) + ' ｜ ' + E(m.unit) + ' ｜ ' + (m.freq === 'year' ? '年值' : '月值') + '</div></div>'
          + '<div class="rt"><b>' + m.rows + '</b>' + E((m.from || '') + '~' + (m.to || '').slice(2)) + '</div></div>';
      });
    } else {
      h += '<div class="mod-note" style="font-size:9.5px">尚未同步。在项目目录执行：<br>'
        + '<b>python tools/gee_sync.py --check</b>（校验凭据）<br>'
        + '<b>python tools/gee_sync.py --start 2015</b>（增量同步）<br>'
        + '产物写入 data/gee/，本页与指标随即生效，无需重启服务。</div>';
    }
    box.innerHTML = h;
  }

  function loadVal() {
    var box = q('dsVal');
    if (!box) return;
    window.dhFetch('/api/validate', 8000).then(function (j) {
      var d = (j && j.data) || {};
      var rows = Object.keys(d).map(function (k) {
        var v = d[k];
        var nm = k === 'temp' ? '气温' : (k === 'precip' ? '降水' : k);
        var u = v.unit || (k === 'temp' ? '℃' : 'mm');
        var ok = Math.abs(v.bias) <= 2.5;
        var raw = v.raw ? ('订正前 r=' + v.raw.r + ' / 偏差 ' + (v.raw.bias > 0 ? '+' : '') + v.raw.bias + u) : '';
        return '<div class="ds-row"><div class="nm"><b>' + nm + '：' + E(v.a) + ' vs ' + E(v.b) + '</b>'
          + '<div class="s">r = ' + v.r + ' ｜ RMSE ' + v.rmse + u
          + ' ｜ 系统偏差 ' + (v.bias > 0 ? '+' : '') + v.bias + u + ' ｜ n = ' + v.n
          + (v.correction ? '<br>' + E(v.correction) : '')
          + (raw ? '<br>' + E(raw) + (v.dz_mean ? '（格元地形较站点低 ' + Math.abs(v.dz_mean) + ' m）' : '') : '')
          + '</div></div>'
          + '<div class="rt"><b style="color:' + (ok ? '#7fe3cd' : '#ffd48a') + '">'
          + (ok ? '一致' : (v.bias > 0 ? '高估' : '低估')) + '</b></div></div>';
      }).join('');
      var notes = Object.keys(d).map(function (k) { return d[k].note; }).filter(Boolean);
      box.innerHTML = (rows || '<div class="mod-note" style="font-size:9.5px">尚未运行交叉验证</div>')
        + (notes.length ? '<div class="rg-tip" style="font-size:8.5px;line-height:1.7;margin-top:4px">'
           + notes.map(E).join('<br>') + '</div>' : '');
    }).catch(function () {
      box.innerHTML = '<div class="mod-note" style="font-size:9.5px">后端不可达</div>';
    });
  }

  function loadPg() {
    var box = q('dsPg');
    if (!box) return;
    window.dhFetch('/api/db/status', 8000).then(function (j) {
      if (!j || !j.ok) {
        box.innerHTML = '<div class="mod-note" style="font-size:9.5px">' +
          E((j && j.error) || '未入库') + '</div>';
        return;
      }
      var c = j.counts || {};
      var rows = Object.keys(c).map(function (k) {
        return '<span style="display:inline-block;margin:0 6px 3px 0;font-family:Consolas,monospace;font-size:9.5px">'
          + E(k) + ' <b style="color:#7fe3cd">' + c[k] + '</b></span>';
      }).join('');
      box.innerHTML = '<div class="ds-row"><div class="nm"><b>' + E(j.db) + ' · ' + E(j.schema || 'app')
        + ' schema</b><div class="s">' + rows + '</div></div>'
        + '<div class="rt"><b style="color:#7fe3cd">已同步</b>' + E((j.time || '').slice(5, 16)) + '</div></div>'
        + '<div class="rg-tip" style="font-size:9px">应用快照每次构建由 tools/pg_sync.py 刷新；'
        + 'public schema 保留人工维护的原始台账。</div>';
    }).catch(function () {
      box.innerHTML = '<div class="mod-note" style="font-size:9.5px">后端不可达</div>';
    });
  }

  function load() {
    var box = q('dsLive');
    if (box && !box.innerHTML) box.innerHTML = '<div class="mod-note">正在读取数据血缘…</div>';
    var a = window.dhFetch('/api/provenance', 9000).catch(function () { return null; });
    var b = window.dhFetch('/api/rs/status', 9000).catch(function () { return null; });
    Promise.all([a, b]).then(function (r) {
      if (!r[0] || !r[0].ok) {
        if (box) box.innerHTML = '<div class="mod-note">后端不可达，无法读取数据血缘。</div>';
        return;
      }
      render(r[0], r[1]);
      loadPg(); loadVal();
    });
  }

  /* 挂载到「数据管理」面板顶部 */
  window.dsLiveMount = function () {
    var B = q('phBody');
    if (!B) return;
    var box = q('dsLive');
    if (!box || !B.contains(box)) {
      box = document.createElement('div');
      box.id = 'dsLive';
      box.className = 'ds-live';
      B.insertBefore(box, B.firstChild);
    }
    load();
  };

  /* 指纹轮询：只有数据真的变了才触发刷新 */
  function tick() {
    window.dhFetch('/api/data/version', 6000).then(function (j) {
      if (!j || !j.ok) return;
      if (DS.token && j.token !== DS.token) {
        DS.token = j.token;
        window.toast && window.toast('数据已更新（指纹 ' + j.token + '），正在同步视图', 'ok', '⟳');
        if (window.dataHubTick) window.dataHubTick();
        if (window.G && window.G.curPh === 'data') load();
        if (window.G && window.G.curPh === 'region' && window.rgOpen) window.rgOpen();
      } else if (!DS.token) {
        DS.token = j.token;
      }
      var be = q('beVal');
      if (be && /实时/.test(be.textContent || '')) {
        be.title = '数据指纹 ' + j.token + ' ｜ 每 ' + DS.interval + 's 比对一次，变化才刷新';
      }
    }).catch(function () {});
  }

  function start() {
    if (DS.timer) return;
    tick();
    DS.timer = setInterval(tick, DS.interval * 1000);
  }
  window.dsLiveStart = start;
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 2500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 2500); });
})();
