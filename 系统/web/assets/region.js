/* ═══════════════════════════════════════════════════════════════════════════
   区域数据治理模块（区域校正）
   ───────────────────────────────────────────────────────────────────────────
   对应需求：「后端需要指定区域也可以手动调整数据（异常数据修正、手动或其他
   源添加部分数据）」+「智能体承上启下完成前后端交互和管理」。

   设计要点
   1. 原始观测（data/stations.json）只读，人工修正单独一层覆盖层 + 变更台账，
      因此任何改动都可追溯、可撤销、可复核；派生指标一律读「有效值」。
   2. 区域粒度支持：全流域 / 三个河段 / 气候地貌分区 / 卫星图上框选的自定义范围。
   3. 异常筛查 → 采纳或驳回 → 台账留痕，形成数据质量闭环。
   4. 每次改动后自动重算指标、刷新三维站点配色，并在场景中打出「涟漪」动效，
      让"改数据 → 指标变化"这件事在视觉上被看见。
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ---------- 0. 基础工具 ---------- */
  function q(id) { return document.getElementById(id); }
  function E(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function f1(v) { return (Math.round(Number(v) * 10) / 10).toFixed(1); }
  function toast2(m, k, ic) { if (window.toast) window.toast(m, k || 'ok', ic || '🗂'); }
  function post(path, body) {
    return window.postJSON(window.dhBaseUrl() + path, body).then(function (j) {
      if (j && j.ok === false) throw new Error(j.error || '后端返回失败');
      return j;
    });
  }
  function get(path) { return window.dhFetch(path, 12000); }

  var DIMS = [
    { k: 'habitat', nm: '生境质量', max: 1 },
    { k: 'biodiversity', nm: '生物多样性', max: 1 },
    { k: 'water', nm: '水源涵养', max: 1000, u: 'mm' },
    { k: 'soil', nm: '土壤保持', max: 40, u: 't/ha' },
    { k: 'climate', nm: '气候调节', max: 1 },
    { k: 'resilience', nm: '生态韧性', max: 1 },
    { k: 'esv', nm: '服务价值', max: 4, u: '万元' },
    { k: 'disturbance', nm: '人类干扰', max: 1, inv: true }
  ];
  var SOURCES = ['野外补测', '会商核定', '其他数据源', '异常剔除', '算法复算'];
  var OPS = [['set', '设为'], ['scale', '乘以'], ['offset', '加上']];

  var RG = {
    regions: null, fields: null, rid: 'basin', d: null, fid: 'lc.林地',
    busy: false, editing: null, prevMean: null, delta: null, online: false,
    highlight: true, reserved: []
  };
  window.RG = RG;

  /* ---------- 1. 样式（前缀 rg-，不与既有样式冲突） ---------- */
  var CSS = ''
    + '.rg-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}'
    + '.rg-chip{font-size:10.5px;padding:3px 8px;border-radius:11px;cursor:pointer;color:#8fb0b5;'
    + 'background:rgba(13,30,38,.85);border:1px solid var(--line);white-space:nowrap;transition:.15s}'
    + '.rg-chip:hover{color:#7fe3cd;border-color:rgba(53,224,184,.45)}'
    + '.rg-chip.on{color:#04231a;background:linear-gradient(180deg,#43e8c0,#1fa895);font-weight:700;border-color:transparent}'
    + '.rg-chip .n{font-family:Consolas,monospace;opacity:.75;margin-left:3px;font-size:9.5px}'
    + '.rg-chip.on .n{opacity:.8}'
    + '.rg-bar{display:flex;align-items:center;gap:6px;margin:3px 0;font-size:10px;color:#9fc6c0}'
    + '.rg-bar .lb{flex:0 0 62px;color:#8fb0b5}'
    + '.rg-bar .tk{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}'
    + '.rg-bar .tk i{display:block;height:100%;border-radius:3px;width:0;transition:width .65s cubic-bezier(.2,.8,.2,1)}'
    + '.rg-bar .vv{flex:0 0 46px;text-align:right;font-family:Consolas,monospace;color:#dff4ee;font-size:10px}'
    + '.rg-sel{width:100%;background:rgba(8,20,27,.95);border:1px solid var(--line);border-radius:5px;'
    + 'color:#d9ecec;font-size:11.5px;padding:5px 7px;outline:none;margin-bottom:7px}'
    + '.rg-row{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:5px;cursor:pointer;'
    + 'background:rgba(13,30,38,.6);border-left:3px solid transparent;margin-bottom:3px;transition:background .14s}'
    + '.rg-row:hover{background:rgba(24,52,62,.9)}'
    + '.rg-row.on{background:rgba(24,60,66,.95);border-left-color:var(--acc)}'
    + '.rg-row b{font-size:11.5px;color:#e6f6f4;font-weight:500;flex:0 0 56px}'
    + '.rg-row .v{flex:1;text-align:right;font-family:Consolas,monospace;font-size:11px;color:#bfe6dc}'
    + '.rg-row .bd{font-size:9px;padding:0 3px;border-radius:3px;line-height:14px}'
    + '.rg-row .bd.ed{color:#ffd48a;border:1px solid rgba(255,212,138,.45)}'
    + '.rg-row .bd.an{color:#ff8a8a;border:1px solid rgba(255,138,138,.45)}'
    + '.rg-edit{background:rgba(10,24,30,.97);border:1px solid rgba(53,224,184,.35);border-radius:6px;'
    + 'padding:7px 8px;margin:0 0 5px}'
    + '.rg-edit .lbl{font-size:9.5px;color:#7fa0a4;margin-bottom:3px;display:flex;justify-content:space-between}'
    + '.rg-edit input,.rg-edit select{width:100%;background:rgba(4,12,16,.95);border:1px solid var(--line);'
    + 'border-radius:4px;color:#e6f6f4;font-size:11.5px;padding:4px 6px;outline:none;margin-bottom:5px}'
    + '.rg-edit input:focus{border-color:rgba(53,224,184,.6)}'
    + '.rg-edit .row2{display:flex;gap:5px}'
    + '.rg-edit .row2>*{flex:1}'
    + '.rg-mini{font-size:10.5px;padding:4px 0;border-radius:4px;border:1px solid var(--line2);'
    + 'color:#b9d6d0;background:rgba(255,255,255,.03);cursor:pointer;text-align:center}'
    + '.rg-mini:hover{border-color:var(--acc);color:#fff}'
    + '.rg-mini.pri{background:linear-gradient(180deg,#43e8c0,#1fa895);color:#04231a;font-weight:700;border-color:transparent}'
    + '.rg-mini.dan{border-color:rgba(255,107,107,.4);color:#ffb0b0}'
    + '.rg-mini:disabled{opacity:.45;cursor:not-allowed}'
    + '.rg-card{background:rgba(13,30,38,.7);border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-bottom:5px}'
    + '.rg-card .hd{display:flex;align-items:center;gap:5px;font-size:10.5px;color:#cfe9e2}'
    + '.rg-card .hd b{color:#fff;font-weight:600;font-size:11px}'
    + '.rg-card .why{font-size:9.5px;color:#7d979b;line-height:1.65;margin-top:2px;font-family:Consolas,monospace}'
    + '.rg-card .acts{display:flex;gap:5px;margin-top:5px}'
    + '.rg-card .acts>*{flex:1}'
    + '.rg-delta{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 2px}'
    + '.rg-delta span{font-size:9.5px;padding:1px 6px;border-radius:9px;font-family:Consolas,monospace;'
    + 'background:rgba(53,224,184,.1);border:1px solid rgba(53,224,184,.3);color:#7fe3cd}'
    + '.rg-delta span.dn{background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.3);color:#ffa8a8}'
    + '.rg-delta span.up{background:rgba(53,224,184,.13);border-color:rgba(53,224,184,.4);color:#8df0dc}'
    + '.rg-fld{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 6px}'
    + '.rg-fld i{font-style:normal;font-size:9.5px;padding:1px 5px;border-radius:3px;cursor:pointer;'
    + 'background:rgba(255,255,255,.05);border:1px solid var(--line);color:#8fb0b5}'
    + '.rg-fld i.on{background:rgba(53,224,184,.16);border-color:rgba(53,224,184,.5);color:#9df0dd}'
    + '.rg-det{border:1px solid var(--line);border-radius:6px;margin-bottom:6px;background:rgba(10,22,28,.6)}'
    + '.rg-det>summary{font-size:11px;color:#8fd8c6;padding:6px 8px;cursor:pointer;outline:none;list-style:none}'
    + '.rg-det>summary::-webkit-details-marker{display:none}'
    + '.rg-det>summary::before{content:"▸ ";color:#5ecfb5}'
    + '.rg-det[open]>summary::before{content:"▾ "}'
    + '.rg-det .bd{padding:0 8px 8px}'
    + '.rg-acts{display:flex;gap:6px;margin-top:9px}'
    + '.rg-acts>*{flex:1}'
    + '.rg-tip{font-size:9.5px;color:#6f8f96;line-height:1.7;margin-top:4px}'
    + '.rg-hl{color:#7fe3cd}'
    + '.rg-off{opacity:.5;pointer-events:none}'
    /* 二维地图框选 */
    + '#rgSel{position:absolute;inset:0;z-index:9;cursor:crosshair;display:none}'
    + '#rgSel.on{display:block}'
    + '#rgSelBox{position:absolute;border:1.5px dashed #35e0b8;background:rgba(53,224,184,.13);'
    + 'pointer-events:none;display:none;border-radius:2px}'
    + '#rgSelCard{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:10;display:none;'
    + 'background:rgba(8,20,27,.96);border:1px solid rgba(53,224,184,.45);border-radius:8px;padding:9px 11px;'
    + 'box-shadow:0 14px 40px -12px #000;min-width:250px}'
    + '#rgSelCard .t{font-size:10.5px;color:#7fe3cd;letter-spacing:1px;margin-bottom:5px}'
    + '#rgSelCard input{width:100%;background:rgba(4,12,16,.95);border:1px solid var(--line);border-radius:4px;'
    + 'color:#e6f6f4;font-size:12px;padding:5px 7px;outline:none;margin-bottom:6px}'
    + '#rgSelCard .b{display:flex;gap:6px}'
    + '#rgSelCard .b>*{flex:1}';

  (function inject() {
    var s = document.createElement('style');
    s.id = 'rg-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  })();

  /* ---------- 2. 数值格式化 ---------- */
  function fieldMeta(fid) {
    var list = RG.fields || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === fid) return list[i];
    return { id: fid, nm: fid, unit: '', frac: false, dec: 1 };
  }
  function fmtV(fid, v) {
    var f = fieldMeta(fid);
    if (v == null) return '—';
    if (f.frac) return (Number(v) * 100).toFixed(1) + '%';
    var n = Number(v);
    return (f.dec >= 2 ? n.toFixed(f.dec) : (Math.round(n * 10) / 10).toFixed(f.dec > 0 ? 1 : 0)) + (f.unit || '');
  }
  function inputToValue(fid, raw) {
    var f = fieldMeta(fid);
    var v = parseFloat(raw);
    if (!isFinite(v)) return null;
    return f.frac ? v / 100 : v;   // 界面按 % 输入，后端存 0–1 分数
  }

  /* ---------- 3. 数据加载 ---------- */
  function rgLoad(keepRid) {
    var box = q('phBody');
    if (box) box.innerHTML = '<div class="mod-note">正在读取区域与治理台账…</div>';
    return get('/api/regions').then(function (j) {
      RG.regions = j.regions || [];
      RG.fields = j.fields || [];
      RG.reserved = j.reserved || [];
      RG.online = true;
      var exists = RG.regions.some(function (r) { return r.id === RG.rid; });
      if (!exists) RG.rid = (keepRid && exists) ? RG.rid : 'basin';
      return rgLoadDetail(RG.rid);
    }).catch(function (e) {
      RG.online = false;
      if (box) box.innerHTML = '<div class="mod-note">后端不可达，区域治理需要实时数据接口。'
        + '请确认 <b>金沙江服务</b> 窗口在运行（或 <b>python server.py</b>）后重试。<br>'
        + '<span style="color:#ff9d9d">' + E(e.message || e) + '</span></div>';
      return null;
    });
  }
  function rgLoadDetail(rid) {
    return get('/api/region?id=' + encodeURIComponent(rid)).then(function (d) {
      RG.rid = rid; RG.d = d;
      if (!RG.fid || !d.fields.some(function (f) { return f.id === RG.fid; })) RG.fid = 'lc.林地';
      rgRender();
      rgHighlight();
      return d;
    });
  }

  /* ---------- 4. 渲染 ---------- */
  function rgRender() {
    var B = q('phBody');
    if (!B) return;
    var d = RG.d;
    if (!d) { rgLoad(); return; }
    var m = d.mean || {}, reg = d.region || {};
    var editedN = d.stations.filter(function (s) { return s.edited.length; }).length;

    var h = '';
    h += '<div class="mod-note"><b>区域数据治理</b>　原始观测只读，人工修正单独成层并逐条留痕；'
      + '指标全部按「有效值」重算。改完立刻在三维场景与全部图表面板生效。</div>';

    /* 区域选择 */
    h += '<div class="sec-lab">区域范围</div><div class="rg-chips" id="rgChips">';
    (RG.regions || []).forEach(function (r) {
      var cls = 'rg-chip' + (r.id === RG.rid ? ' on' : '') + (r.kind === 'custom' ? ' custom' : '');
      h += '<span class="' + cls + '" data-r="' + E(r.id) + '" title="' + E(r.desc || '') + '">'
        + E(r.name) + '<span class="n">' + r.count + '</span></span>';
    });
    h += '<span class="rg-chip" id="rgPick2d" title="切到卫星影像，拖拽框选一块范围并命名">＋框选</span></div>';
    h += '<div class="rg-tip">当前：<b class="rg-hl">' + E(reg.name || '') + '</b>　' + E(reg.desc || '')
      + '<br>站点 ' + d.stations.length + ' 个 ｜ 已修正 <b class="rg-hl">' + editedN + '</b> 站 ｜ 台账 '
      + (d.changes || []).length + ' 条</div>';

    /* 指标概览 */
    h += '<div class="sec-lab">区域生态指标</div>';
    h += '<div class="kmini"><div><span>综合指数 EEI</span><b id="rgEei">' + f1(m.eei)
      + '</b><i style="font-style:normal;font-size:9px;color:#7fe3cd"> ' + E(m.grade || '') + '</i></div>'
      + '<div><span>综合风险 R</span><b id="rgRisk">' + f1(m.risk) + '</b></div>'
      + '<div><span>碳密度 tC/ha</span><b id="rgCarbon">' + f1(m.carbon) + '</b></div></div>';
    h += '<div id="rgDims">' + dimsHtml(m) + '</div>';
    h += '<div id="rgDelta"></div>';

    /* 逐站数据 */
    h += '<div class="sec-lab">逐站数据 · 可修正</div>';
    h += '<select class="rg-sel" id="rgField">';
    (RG.fields || []).forEach(function (f) {
      h += '<option value="' + f.id + '"' + (f.id === RG.fid ? ' selected' : '') + '>'
        + E(f.nm) + (f.unit ? '（' + E(f.unit) + '）' : '') + '</option>';
    });
    h += '</select>';
    h += '<div id="rgStations">' + stationsHtml() + '</div>';
    h += '<div class="rg-tip">点站名展开行内修正：填新值 + 原因（必填）+ 数据来源。'
      + '<span style="color:#ffd48a">✎</span> 已人工修正　<span style="color:#ff8a8a">⚠</span> 筛查待复核</div>';

    /* 批量调整 */
    h += '<details class="rg-det" id="rgBatchDet"><summary>批量调整（整块区域一起改）</summary><div class="bd">';
    h += '<div class="lbl" style="font-size:9.5px;color:#7fa0a4;margin-bottom:3px">对「' + E(reg.name) + '」内全部 '
      + d.stations.length + ' 站生效</div>';
    h += '<select class="rg-sel" id="rgBFld">';
    (RG.fields || []).forEach(function (f) {
      h += '<option value="' + f.id + '"' + (f.id === RG.fid ? ' selected' : '') + '>' + E(f.nm) + '</option>';
    });
    h += '</select>';
    h += '<div style="display:flex;gap:5px;margin-bottom:5px">'
      + '<select class="rg-sel" id="rgBOp" style="flex:0 0 76px;margin:0">'
      + OPS.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('')
      + '</select>'
      + '<input class="rg-sel" id="rgBVal" style="margin:0;flex:1" placeholder="倍数 1.15 / 数值 750">'
      + '</div>';
    h += '<input class="rg-sel" id="rgBWhy" placeholder="调整原因（必填，写入台账）">';
    h += '<div style="display:flex;gap:5px">'
      + '<select class="rg-sel" id="rgBSrc" style="margin:0;flex:1">'
      + SOURCES.map(function (s) { return '<option>' + s + '</option>'; }).join('')
      + '</select>'
      + '<button class="rg-mini pri" id="rgBGo" style="flex:1">应用并重算</button></div>';
    h += '<div class="rg-tip">「乘以 1.15」= 整体上调 15%；「加上 5」对下垫面为 5 个百分点。'
      + '下垫面字段的「设为」按百分数填写，如 62 表示 62%。</div>';
    h += '</div></details>';

    /* 异常筛查 */
    var an = d.anomalies || [];
    h += '<div class="sec-lab">异常筛查 <span style="letter-spacing:0;color:#7d979b;font-size:9px">'
      + an.length + ' 条待复核</span></div>';
    h += '<div id="rgAnoms">' + anomsHtml(an) + '</div>';

    /* 变更台账 */
    h += '<div class="sec-lab">变更台账 <span style="letter-spacing:0;color:#7d979b;font-size:9px">最近 '
      + (d.changes || []).length + ' 条</span></div>';
    h += '<div id="rgChanges">' + changesHtml(d.changes || []) + '</div>';

    /* 追加观测 */
    h += '<details class="rg-det" id="rgObsDet"><summary>追加观测（手工补测 / 其他数据源）</summary><div class="bd">';
    h += '<select class="rg-sel" id="rgOSta">'
      + d.stations.map(function (s) { return '<option>' + E(s.name) + '</option>'; }).join('') + '</select>';
    h += '<div style="display:flex;gap:5px;margin-bottom:5px">'
      + '<select class="rg-sel" id="rgOFld" style="margin:0;flex:1.2">'
      + (RG.fields || []).map(function (f) { return '<option value="' + f.id + '">' + E(f.nm) + '</option>'; }).join('')
      + '</select>'
      + '<input class="rg-sel" id="rgOVal" style="margin:0;flex:1" placeholder="数值">'
      + '</div>';
    h += '<div style="display:flex;gap:5px;margin-bottom:5px">'
      + '<input class="rg-sel" id="rgOT" style="margin:0;flex:1" value="' + new Date().toISOString().slice(0, 7) + '" title="观测时间（YYYY-MM）">'
      + '<select class="rg-sel" id="rgOSrc" style="margin:0;flex:1">'
      + SOURCES.map(function (s) { return '<option>' + s + '</option>'; }).join('')
      + '</select></div>';
    h += '<input class="rg-sel" id="rgONote" placeholder="备注：仪器/批次/口径说明">';
    h += '<button class="rg-mini pri" id="rgOGo" style="width:100%">登记并设为当前有效值</button>';
    h += '<div class="rg-tip">观测台账带时间戳，为后续「时间维度」预留接口；'
      + '字段清单已预留 ' + (RG.reserved || []).join('、') + '。</div>';
    h += '</div></details>';

    /* 底部动作 */
    h += '<div class="rg-acts">'
      + '<button class="rg-mini" id="rgHl">' + (RG.highlight ? '◉ 场景高亮中' : '○ 场景高亮') + '</button>'
      + '<button class="rg-mini" id="rgReset">↺ 区域回退</button>'
      + '<button class="rg-mini" id="rgExport">⬇ 导出台账</button>'
      + '</div>';
    h += '<div class="rg-tip">回退会把本区域的人工修正全部清除（同样记入台账），原始观测值不受影响。</div>';

    B.innerHTML = h;
    rgBind();
    rgAnimateBars();
    renderDelta();
  }

  function dimsHtml(m) {
    return DIMS.map(function (d) {
      var v = Number(m[d.k] || 0);
      var pct = Math.max(2, Math.min(100, (d.inv ? 1 - v / d.max : v / d.max) * 100));
      var txt = d.max >= 100 ? v.toFixed(0) : v.toFixed(2);
      var col = d.inv ? '#e8813a' : '#35e0b8';
      return '<div class="rg-bar" data-dim="' + d.k + '"><span class="lb">' + d.nm + '</span>'
        + '<span class="tk"><i data-w="' + pct.toFixed(1) + '" style="background:' + col + '"></i></span>'
        + '<span class="vv">' + txt + '</span></div>';
    }).join('') + '<div class="rg-tip">' + (Number(m.eei) >= 75 ? 'A 优' : Number(m.eei) >= 65 ? 'B 良'
      : Number(m.eei) >= 55 ? 'C 一般' : 'D 较差') + '：EEI 由 8 维加权合成（与「智能评估」同口径）</div>';
  }

  function stationsHtml() {
    var d = RG.d;
    if (!d) return '';
    var anSet = {};
    (d.anomalies || []).forEach(function (a) { anSet[a.station + '|' + a.field] = true; });
    return d.stations.map(function (s) {
      var ed = s.edited.indexOf(RG.fid) >= 0;
      var an = anSet[s.name + '|' + RG.fid];
      var on = RG.editing === s.name ? ' on' : '';
      var html = '<div class="rg-row' + on + '" data-n="' + E(s.name) + '">'
        + '<b>' + E(s.name) + '</b>'
        + '<span class="v">' + fmtV(RG.fid, s.v[RG.fid]) + '</span>'
        + (ed ? '<span class="bd ed" title="已人工修正">✎</span>' : '')
        + (an ? '<span class="bd an" title="筛查待复核">⚠</span>' : '')
        + '</div>';
      if (RG.editing === s.name) html += editHtml(s);
      return html;
    }).join('');
  }

  function editHtml(s) {
    var fm = fieldMeta(RG.fid);
    var cur = fm.frac ? (Number(s.v[RG.fid]) * 100).toFixed(1) : s.v[RG.fid];
    return '<div class="rg-edit">'
      + '<div class="lbl"><span>' + E(s.name) + ' · ' + E(fm.nm) + (fm.unit ? '（' + E(fm.unit) + '）' : '')
      + '</span><span>当前 ' + fmtV(RG.fid, s.v[RG.fid]) + '</span></div>'
      + '<input id="rgEdVal" type="number" step="any" value="' + cur + '" placeholder="新值">'
      + '<input id="rgEdWhy" placeholder="修正原因（必填）">'
      + '<div class="row2" style="margin-bottom:5px">'
      + '<select id="rgEdSrc">' + SOURCES.map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select>'
      + '</div>'
      + '<div class="row2"><button class="rg-mini pri" id="rgEdGo">保存修正</button>'
      + '<button class="rg-mini" id="rgEdNo">取消</button></div></div>';
  }

  function anomsHtml(list) {
    if (!list.length) {
      return '<div class="mod-note" style="margin-bottom:8px">当前口径下没有命中筛查规则的可疑值。'
        + '规则：稳健 Z（中位数 + MAD）+ 空间邻域一致性双判据，气温另按 6.5 ℃/km 订正到站点高程。</div>';
    }
    return list.map(function (a, i) {
      return '<div class="rg-card" data-ai="' + i + '">'
        + '<div class="hd"><b>' + E(a.station) + '</b><span style="color:#9fb8bb">' + E(a.fieldNm) + '</span>'
        + '<span style="margin-left:auto;font-family:Consolas,monospace;font-size:10px;color:#ffb0b0">'
        + fmtV(a.field, a.value) + '</span>'
        + '<span style="font-size:9px;color:' + (a.level === '高' ? '#ff8a8a' : '#ffd48a') + '">' + a.level + '</span></div>'
        + '<div class="why">' + E(a.why) + '<br>邻域参照 ' + fmtV(a.field, a.nbr) + '（'
        + (a.nbrDist || '—') + ' km 内 3 站反距离加权）</div>'
        + '<div class="acts"><button class="rg-mini pri" data-adopt="' + i + '">采纳 → '
        + fmtV(a.field, a.suggest) + '</button>'
        + '<button class="rg-mini" data-dismiss="' + i + '">已核查</button></div></div>';
    }).join('');
  }

  function changesHtml(list) {
    if (!list.length) return '<div class="rg-tip" style="margin-bottom:8px">还没有变更记录。</div>';
    var kmap = { adjust: '区域调数', correct: '单站修正', reset: '区域回退', observe: '追加观测' };
    var omap = { set: '设为', scale: '乘以', offset: '加上' };
    return list.map(function (c) {
      var op = c.kind === 'adjust' ? (omap[c.op] || '') + ' ' + c.value : '';
      var und = c.undone;
      return '<div class="rg-card" style="' + (und ? 'opacity:.5' : '') + '">'
        + '<div class="hd"><b>' + E(c.id) + '</b><span style="color:#9fb8bb">' + E(kmap[c.kind] || c.kind) + '</span>'
        + '<span style="margin-left:auto;font-family:Consolas,monospace;font-size:9.5px;color:#7d979b">'
        + E((c.t || '').slice(5, 16)) + '</span></div>'
        + '<div class="why">' + E(c.regionName || '') + ' · ' + E(c.fieldNm || '') + ' ' + E(op)
        + '　影响 ' + (c.n || 0) + ' 站<br>' + E(c.reason || '') + ' ｜ ' + E(c.source || '')
        + (und ? '　<b style="color:#ffa8a8">已撤销</b>' : '') + '</div>'
        + (!und ? '<div class="acts"><button class="rg-mini dan" data-undo="' + E(c.id) + '">撤销这条</button></div>' : '')
        + '</div>';
    }).join('');
  }

  /* ---------- 5. 动效 ---------- */
  function rgAnimateBars() {
    var bars = document.querySelectorAll('#rgDims .tk i');
    bars.forEach(function (b) { b.style.width = '0'; });
    requestAnimationFrame(function () {
      setTimeout(function () {
        bars.forEach(function (b) { b.style.width = (b.dataset.w || 0) + '%'; });
      }, 30);
    });
  }
  function renderDelta() {
    var box = q('rgDelta');
    if (!box) return;
    if (!RG.delta) { box.innerHTML = ''; return; }
    var keys = [['eei', 'EEI'], ['risk', '风险'], ['carbon', '碳密度'], ['fvc', '覆盖度']];
    box.innerHTML = '<div class="rg-delta">' + keys.map(function (k) {
      var a = RG.delta.before[k[0]], b = RG.delta.after[k[0]];
      if (a == null || b == null) return '';
      var d = b - a;
      if (Math.abs(d) < 0.05) return '<span>' + k[1] + ' 持平</span>';
      var good = (k[0] === 'risk') ? d < 0 : d > 0;
      return '<span class="' + (good ? 'up' : 'dn') + '">' + k[1] + ' '
        + (d > 0 ? '+' : '') + d.toFixed(1) + '</span>';
    }).join('') + '<span>较调整前</span></div>';
    RG.delta = null;
  }

  /* ---------- 6. 事件绑定 ---------- */
  function rgBind() {
    var B = q('phBody');
    if (!B) return;

    B.querySelectorAll('#rgChips [data-r]').forEach(function (el) {
      el.onclick = function () {
        RG.rid = el.dataset.r; RG.editing = null; RG.delta = null;
        rgLoadDetail(RG.rid);
      };
    });
    var pk = q('rgPick2d');
    if (pk) pk.onclick = rgStartSelect;

    var fs = q('rgField');
    if (fs) fs.onchange = function () { RG.fid = fs.value; RG.editing = null; rgRender(); };

    rgBindStations();

    /* 批量 */
    var bg = q('rgBGo');
    if (bg) bg.onclick = function () {
      var fid = q('rgBFld').value, op = q('rgBOp').value;
      var raw = q('rgBVal').value.trim(), why = q('rgBWhy').value.trim();
      var src = q('rgBSrc').value;
      if (!raw) { toast2('请填写数值', 'warn', '⚠'); return; }
      if (!why) { toast2('请填写调整原因（台账留痕要求）', 'warn', '⚠'); return; }
      var fm = fieldMeta(fid), val;
      if (op === 'scale') {
        val = parseFloat(raw);
        if (!isFinite(val) || val <= 0) { toast2('倍数需为正数', 'warn', '⚠'); return; }
      } else {
        val = inputToValue(fid, raw);
        if (val == null) { toast2('数值格式不正确', 'warn', '⚠'); return; }
      }
      var label = { set: '设为 ', scale: '乘以 ', offset: '加上 ' }[op] + (op === 'scale' ? val : raw);
      if (!confirm('将对「' + (RG.d.region.name) + '」内 ' + RG.d.stations.length + ' 站执行：\n'
        + fm.nm + ' ' + label + '\n原因：' + why + '\n\n确认应用并重算全部指标？')) return;
      rgDo('/api/region/adjust', {
        region: RG.rid, field: fid, op: op, value: val, reason: why, source: src
      }, fm.nm + ' ' + label);
    };

    /* 异常采纳 / 驳回 */
    B.querySelectorAll('[data-adopt]').forEach(function (el) {
      el.onclick = function () {
        var a = RG.d.anomalies[+el.dataset.adopt];
        if (!a) return;
        var r = prompt('采纳建议值并写入修正台账。\n\n' + a.station + ' · ' + a.fieldNm
          + '\n当前 ' + fmtV(a.field, a.value) + ' → 建议 ' + fmtV(a.field, a.suggest)
          + '\n\n请填写修正原因：', '数据质量筛查：' + a.why);
        if (r == null) return;
        if (!r.trim()) { toast2('原因不能为空', 'warn', '⚠'); return; }
        var fm = fieldMeta(a.field);
        var v = fm.frac ? a.suggest : a.suggest;
        rgDo('/api/station/correct', {
          name: a.station, field: a.field, value: v, reason: r.trim(), source: '异常数据修正'
        }, a.station + ' ' + a.fieldNm + ' 修正');
      };
    });
    B.querySelectorAll('[data-dismiss]').forEach(function (el) {
      el.onclick = function () {
        var a = RG.d.anomalies[+el.dataset.dismiss];
        if (!a) return;
        var r = prompt('标记为「已人工核查，维持原值」，之后不再提示该条。\n\n'
          + a.station + ' · ' + a.fieldNm + ' = ' + fmtV(a.field, a.value) + '\n\n核查说明：', '经复核，该值符合实地情况');
        if (r == null) return;
        post('/api/anomalies/dismiss', { station: a.station, field: a.field, reason: r })
          .then(function () { toast2(a.station + ' ' + a.fieldNm + ' 已标记核查', 'ok', '✓'); return rgLoadDetail(RG.rid); })
          .catch(function (e) { toast2(e.message, 'err', '✕'); });
      };
    });

    /* 撤销 */
    B.querySelectorAll('[data-undo]').forEach(function (el) {
      el.onclick = function () {
        if (!confirm('撤销变更 ' + el.dataset.undo + '？该次修正的数值将恢复为修改前的状态。')) return;
        rgDo('/api/changes/undo', { id: el.dataset.undo }, '撤销 ' + el.dataset.undo);
      };
    });

    /* 追加观测 */
    var og = q('rgOGo');
    if (og) og.onclick = function () {
      var fid = q('rgOFld').value, raw = q('rgOVal').value.trim();
      if (!raw) { toast2('请填写观测值', 'warn', '⚠'); return; }
      var v = inputToValue(fid, raw);
      if (v == null) { toast2('数值格式不正确', 'warn', '⚠'); return; }
      post('/api/observations', {
        station: q('rgOSta').value, field: fid, value: v,
        t: q('rgOT').value.trim(), source: q('rgOSrc').value, note: q('rgONote').value.trim(), apply: true
      }).then(function (j) {
        toast2('已登记观测 ' + j.observation.id + ' 并设为当前有效值', 'ok', '📝');
        RG.delta = null;
        return rgAfterWrite(j);
      }).catch(function (e) { toast2(e.message, 'err', '✕'); });
    };

    /* 底部 */
    var hl = q('rgHl');
    if (hl) hl.onclick = function () {
      RG.highlight = !RG.highlight;
      rgHighlight();
      if (!RG.highlight) rgClearHl();
      else rgHighlight();
      hl.textContent = RG.highlight ? '◉ 场景高亮中' : '○ 场景高亮';
      hl.className = 'rg-mini' + (RG.highlight ? ' pri' : '');
    };
    var rs = q('rgReset');
    if (rs) rs.onclick = function () {
      if (!confirm('把「' + RG.d.region.name + '」内全部人工修正回退为原始观测？\n（本次回退也会记入台账，可再次撤销）')) return;
      rgDo('/api/region/reset', { region: RG.rid, reason: '人工批量回退' }, '区域回退');
    };
    var ex = q('rgExport');
    if (ex) ex.onclick = function () {
      window.open(window.dhBaseUrl() + '/api/gov/export', '_blank');
      toast2('已导出治理台账 CSV', 'ok', '⬇');
    };
  }

  function rgBindStations() {
    var box = q('rgStations');
    if (!box) return;
    /* 行点击 → 展开/收起行内编辑器。innerHTML 重绘后必须重新绑定，
       否则点第二行就没反应（第一版踩过这个坑） */
    box.querySelectorAll('.rg-row').forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.closest('.rg-edit')) return;
        var n = el.dataset.n;
        RG.editing = (RG.editing === n) ? null : n;
        box.innerHTML = stationsHtml();
        rgBindStations();
        var inp = q('rgEdVal');
        if (inp) { inp.focus(); inp.select(); }
      };
    });
    var go = q('rgEdGo'), no = q('rgEdNo');
    if (go) go.onclick = function () {
      var name = RG.editing;
      var raw = q('rgEdVal').value.trim(), why = q('rgEdWhy').value.trim();
      if (!why) { toast2('请填写修正原因（台账留痕要求）', 'warn', '⚠'); return; }
      var v = inputToValue(RG.fid, raw);
      if (v == null) { toast2('数值格式不正确', 'warn', '⚠'); return; }
      rgDo('/api/station/correct', {
        name: name, field: RG.fid, value: v, reason: why, source: q('rgEdSrc').value
      }, name + ' ' + fieldMeta(RG.fid).nm + ' 修正');
    };
    if (no) no.onclick = function () {
      RG.editing = null;
      q('rgStations').innerHTML = stationsHtml();
      rgBind();
    };
  }

  /* ---------- 7. 写操作统一收口 ---------- */
  function rgDo(path, body, label) {
    if (RG.busy) { toast2('上一次操作还在进行中', 'warn', '⏳'); return; }
    RG.busy = true;
    post(path, body).then(function (j) {
      RG.busy = false; RG.editing = null;
      RG.delta = { before: j.before || (RG.d&&RG.d.mean) || {}, after: j.after || j.mean || (RG.d&&RG.d.mean) || {} };
      toast2((label || '已应用') + '　已重算全部指标', 'ok', '✓');
      return rgAfterWrite(j);
    }).catch(function (e) {
      RG.busy = false;
      toast2(e.message || '操作失败', 'err', '✕');
    });
  }

  /** 写操作后：同步前端站点数据 → 重建三维站点层 → 重绘当前区域 + 涟漪 */
  function rgAfterWrite(resp) {
    return window.dhFetch('/api/legacy/stations', 9000).then(function (st) {
      if (st && st.length && window.normalizeStation) {
        window.STATIONS = st.map(window.normalizeStation);
        try { if (window.buildStations) window.buildStations(); } catch (e) {}
        try { if (window.drawProfile) window.drawProfile(); } catch (e) {}
        try { if (window.m2RenderMarks) window.m2RenderMarks(); } catch (e) {}
      }
    }).catch(function () {}).then(function () {
      rgRipple();
      return rgLoadDetail(RG.rid);
    });
  }

  /* ---------- 8. 三维：区域围栏 + 涟漪 ---------- */
  var RG3 = { obj: null, ripple: null, t0: 0, anim: 0 };

  function rgClearHl() {
    if (RG3.obj && RG3.obj.parent) RG3.obj.parent.remove(RG3.obj);
    RG3.obj = null;
  }

  function hull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    var lo = [], up = [], i;
    for (i = 0; i < p.length; i++) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
      lo.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
      up.push(p[i]);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  function rgBoundary() {
    var d = RG.d;
    if (!d) return null;
    if (d.region.bbox) {
      var b = d.region.bbox;
      return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    }
    var pts = d.stations.map(function (s) { return [s.lon, s.lat]; });
    if (pts.length === 1) {
      var s0 = pts[0], r = 0.18, out = [];
      for (var k = 0; k < 12; k++) {
        var a = k / 12 * Math.PI * 2;
        out.push([s0[0] + Math.cos(a) * r, s0[1] + Math.sin(a) * 0.9]);
      }
      return out;
    }
    var hl = hull(pts);
    // 外扩一点，避免围栏压在站点上
    var cx = 0, cy = 0;
    hl.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= hl.length; cy /= hl.length;
    return hl.map(function (p) {
      var dx = p[0] - cx, dy = p[1] - cy, L = Math.hypot(dx, dy) || 1;
      return [p[0] + dx / L * 0.08, p[1] + dy / L * 0.08];
    });
  }

  function rgHighlight() {
    if (!window.THREE || !window.scene || !window.toWorld) return;
    rgClearHl();
    if (!RG.highlight || !RG.d) return;
    var bd = rgBoundary();
    if (!bd || bd.length < 2) return;
    var H = 5.5, seg = [];
    for (var i = 0; i < bd.length; i++) {
      var a = bd[i], b = bd[(i + 1) % bd.length];
      var n = Math.max(4, Math.round(Math.hypot((b[0] - a[0]) * 90, (b[1] - a[1]) * 102) / 4));
      for (var t = 0; t < n; t++) {
        var u = t / n, v = (t + 1) / n;
        seg.push([[a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u],
                  [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v]]);
      }
    }
    var pos = [], idx = [], tops = [], vi = 0;
    seg.forEach(function (s) {
      var y0 = window.terrainYAt(s[0][0], s[0][1]) * window.G.exag;
      var y1 = window.terrainYAt(s[1][0], s[1][1]) * window.G.exag;
      var p0 = window.toWorld(s[0][0], s[0][1]), p1 = window.toWorld(s[1][0], s[1][1]);
      pos.push(p0.x, y0 + 0.4, p0.z, p0.x, y0 + H, p0.z,
               p1.x, y1 + 0.4, p1.z, p1.x, y1 + H, p1.z);
      idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
      if (!tops.length) tops.push([p0.x, y0 + H, p0.z]);
      tops.push([p1.x, y1 + H, p1.z]);
      vi += 4;
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x35e0b8, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    var group = new THREE.Group();
    group.add(new THREE.Mesh(g, mat));
    var lg = new THREE.BufferGeometry();
    var lp = [];
    tops.forEach(function (p) { lp.push(p[0], p[1], p[2]); });
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    var line = new THREE.LineLoop(lg, new THREE.LineBasicMaterial({
      color: 0x6cf0cf, transparent: true, opacity: 0.85
    }));
    group.add(line);
    window.scene.add(group);
    RG3.obj = group; RG3.mat = mat; RG3.t0 = performance.now();
  }

  function rgRipple() {
    if (!window.THREE || !window.scene || !RG.d) return;
    var d = RG.d;
    var cx = 0, cy = 0, maxY = 0;
    d.stations.forEach(function (s) {
      cx += s.lon; cy += s.lat;
      maxY = Math.max(maxY, window.terrainYAt(s.lon, s.lat) * window.G.exag);
    });
    cx /= d.stations.length; cy /= d.stations.length;
    var w = window.toWorld(cx, cy);
    var geo = new THREE.RingGeometry(0.92, 1, 64);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x6cf0cf, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false
    });
    var ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(w.x, maxY + 2.2, w.z);
    ring.scale.setScalar(1);
    window.scene.add(ring);
    var t0 = performance.now();
    (function step() {
      var k = (performance.now() - t0) / 1500;
      if (k >= 1) { window.scene.remove(ring); geo.dispose(); mat.dispose(); return; }
      ring.scale.setScalar(1 + k * 46);
      mat.opacity = 0.85 * (1 - k) * (1 - k);
      requestAnimationFrame(step);
    })();
  }

  /* ---------- 9. 二维地图框选自定义区域 ---------- */
  function rgStartSelect() {
    if (!window.M2) { toast2('地图组件未就绪', 'warn', '⚠'); return; }
    if (!window.M2.on) window.m2Toggle(true);
    setTimeout(function () {
      var box = q('map2d');
      if (!box) return;
      var ov = q('rgSel');
      if (!ov) {
        ov = document.createElement('div'); ov.id = 'rgSel';
        var rb = document.createElement('div'); rb.id = 'rgSelBox';
        var card = document.createElement('div'); card.id = 'rgSelCard';
        card.innerHTML = '<div class="t">新建自定义区域</div>'
          + '<input id="rgSelName" placeholder="区域名称，如「白鹤滩库区」">'
          + '<input id="rgSelNote" placeholder="备注（可选）">'
          + '<div class="b"><button class="rg-mini pri" id="rgSelOk">创建区域</button>'
          + '<button class="rg-mini" id="rgSelNo">取消</button></div>';
        ov.appendChild(rb); box.appendChild(ov); box.appendChild(card);
      }
      ov.classList.add('on');
      var rb = q('rgSelBox'), card = q('rgSelCard');
      card.style.display = 'none';
      var drag = null, cur = null;
      toast2('在卫星影像上按住鼠标拖出一块矩形范围', 'ok', '🖱');

      function rel(e) {
        var r = ov.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      }
      function px2ll(px, py) {
        var sc = Math.pow(2, window.M2.zf);
        var c = window.m2Proj(window.M2.lon, window.M2.lat);
        var cx = ov.clientWidth / 2, cy = ov.clientHeight / 2;
        return window.m2Unproj(c.x - (px - cx) / sc, c.y - (py - cy) / sc);
      }
      ov.onmousedown = function (e) {
        e.stopPropagation(); e.preventDefault();
        drag = rel(e); cur = drag.slice();
        rb.style.display = 'block';
        rb.style.left = drag[0] + 'px'; rb.style.top = drag[1] + 'px';
        rb.style.width = '0px'; rb.style.height = '0px';
      };
      ov.onmousemove = function (e) {
        if (!drag) return;
        e.stopPropagation();
        var p = rel(e);
        var x = Math.min(drag[0], p[0]), y = Math.min(drag[1], p[1]);
        var w = Math.abs(p[0] - drag[0]), h = Math.abs(p[1] - drag[1]);
        rb.style.left = x + 'px'; rb.style.top = y + 'px';
        rb.style.width = w + 'px'; rb.style.height = h + 'px';
        cur = [x, y, x + w, y + h];
      };
      ov.onmouseup = function (e) {
        if (!drag) return;
        e.stopPropagation();
        drag = null;
        if (!cur || (cur[2] - cur[0]) < 24 || (cur[3] - cur[1]) < 24) {
          rb.style.display = 'none'; toast2('范围太小，请重新拖拽', 'warn', '⚠'); return;
        }
        var ll1 = px2ll(cur[0], cur[1]), ll2 = px2ll(cur[2], cur[3]);
        rgSelBox = [Math.min(ll1[0], ll2[0]), Math.min(ll1[1], ll2[1]),
                    Math.max(ll1[0], ll2[0]), Math.max(ll1[1], ll2[1])];
        card.style.display = 'block';
        var nm = q('rgSelName');
        nm.value = '自定义区域 ' + new Date().toTimeString().slice(0, 5);
        nm.focus(); nm.select();
      };
      q('rgSelNo').onclick = function () {
        ov.classList.remove('on'); rb.style.display = 'none'; card.style.display = 'none';
      };
      q('rgSelOk').onclick = function () {
        var nm = q('rgSelName').value.trim();
        if (!nm) { toast2('请填写区域名称', 'warn', '⚠'); return; }
        post('/api/regions', { name: nm, bbox: rgSelBox, note: q('rgSelNote').value.trim() })
          .then(function (j) {
            toast2('已创建「' + nm + '」，覆盖 ' + j.count + ' 站', 'ok', '✓');
            ov.classList.remove('on'); rb.style.display = 'none'; card.style.display = 'none';
            RG.rid = j.region.id;
            return rgLoad();
          }).catch(function (e) { toast2(e.message, 'err', '✕'); });
      };
    }, 320);
  }
  var rgSelBox = null;

  /* ---------- 10. 对外接口 ---------- */
  window.rgRender = function () {
    if (!RG.d) return rgLoad();
    rgRender();
  };
  window.rgOpen = function (rid) {
    if (rid) RG.rid = rid;
    return rgLoad();
  };

  /* ---------- 11. 智能体工具（承上启下：理解 → 改数据 → 重算 → 回报） ---------- */
  function rgFieldFromText(t) {
    var M = [['林地', 'lc.林地'], ['草地', 'lc.草地灌丛'], ['灌丛', 'lc.草地灌丛'],
      ['农田', 'lc.农田'], ['耕地', 'lc.农田'], ['建成区', 'lc.建成区'], ['不透水', 'lc.建成区'],
      ['裸地', 'lc.裸地'], ['水体', 'lc.水体'], ['水域', 'lc.水体'], ['湿地', 'lc.湿地'],
      ['降水', 'precip'], ['降雨', 'precip'], ['雨量', 'precip'],
      ['气温', 'temp'], ['温度', 'temp'], ['均温', 'temp'],
      ['海拔', 'elev'], ['高程', 'elev'], ['坡度', 'slope']];
    for (var i = 0; i < M.length; i++) if (t.indexOf(M[i][0]) >= 0) return M[i][1];
    return null;
  }
  function rgRegionFromText(t, list) {
    var best = null;
    (list || []).forEach(function (r) {
      if (r.id === 'basin') return;
      if (t.indexOf(r.name) >= 0 && (!best || r.name.length > best.name.length)) best = r;
    });
    if (best) return best;
    if (/上游/.test(t)) return pick('seg_up');
    if (/中游/.test(t)) return pick('seg_mid');
    if (/下游/.test(t)) return pick('seg_low');
    if (/全流域|整个流域|流域整体|全区/.test(t)) return pick('basin');
    function pick(id) { return (list || []).filter(function (r) { return r.id === id; })[0] || null; }
    return null;
  }
  function rgStationFromText(t) {
    var S = window.STATIONS || [];
    for (var i = 0; i < S.length; i++) if (t.indexOf(S[i][0]) >= 0) return S[i][0];
    return null;
  }
  /* 数值 + 方式解析 */
  function rgParseChange(t, fid) {
    var pct = t.match(/(\d+(?:\.\d+)?)\s*(?:%|％|个百分点)/);
    var num = t.match(/(?:到|为|成|至|=|设为|改成|改为|调到)\s*(-?\d+(?:\.\d+)?)/)
      || t.match(/(-?\d+(?:\.\d+)?)/);
    var v = pct ? parseFloat(pct[1]) : (num ? parseFloat(num[1]) : null);
    if (v == null) return null;
    var fm = (RG.fields || []).filter(function (f) { return f.id === fid; })[0] || { frac: false };
    if (/(上调|提高|增加|上升|涨|增强|扩大)/.test(t)) {
      var step = parseFloat((t.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      if (pct) return { op: 'scale', value: 1 + v / 100 };
      if (/个百分点/.test(t)) return { op: 'offset', value: fm.frac ? v / 100 : v };
      return { op: 'scale', value: 1 + step / 100 };
    }
    if (/(下调|降低|减少|下降|削减|退耕|减少)/.test(t)) {
      var s2 = parseFloat((t.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      if (pct) return { op: 'scale', value: 1 - v / 100 };
      return { op: 'scale', value: 1 - s2 / 100 };
    }
    if (/(设为|改成|改为|调到|调整为|修正为|订正为|等于)/.test(t))
      return { op: 'set', value: fm.frac && v > 1 ? v / 100 : v };
    if (/(加|增加)/.test(t)) return { op: 'offset', value: fm.frac && v > 1 ? v / 100 : v };
    return null;
  }

  // 工具实现
  var TOOLS = {
    region_list: function () {
      return get('/api/regions').then(function (j) {
        RG.regions = j.regions || []; RG.fields = j.fields || [];
        var rows = RG.regions.map(function (r) {
          return '<tr><td>' + E(r.name) + '</td><td>' + r.count + '</td><td>' + (r.edited || 0) + '</td>'
            + '<td>' + f1(r.mean.eei) + '</td><td>' + f1(r.mean.risk) + '</td></tr>';
        }).join('');
        return {
          ok: true, html: '共 <b>' + RG.regions.length + '</b> 个可选区域（含河段、气候分区与自定义范围）：'
            + '<table><tr><th>区域</th><th>站点</th><th>已修正</th><th>EEI</th><th>风险</th></tr>' + rows + '</table>'
            + '<div class="src">数据源：/api/regions · 台账共 ' + (j.overrides || 0) + ' 个站点存在人工修正</div>'
        };
      });
    },

    region_adjust: function (a) {
      return get('/api/regions').then(function (j) {
        RG.regions = j.regions || []; RG.fields = j.fields || [];
        var reg = rgRegionFromText(a.region || '', RG.regions);
        if (!reg) throw new Error('未识别区域：' + (a.region || ''));
        var fid = a.field || 'lc.林地';
        var label = (RG.fields.filter(function (f) { return f.id === fid; })[0] || {}).nm || fid;
        var op = a.op || 'scale', val = Number(a.value);
        return post('/api/region/adjust', {
          region: reg.id, field: fid, op: op, value: val,
          reason: a.reason || '智能体指令', source: a.source || '智能体'
        }).then(function (r) {
          RG.rid = reg.id; RG.delta = { before: r.before, after: r.after };
          return rgAfterWrite(r).then(function () {
            return {
              ok: true, html: '已在「<b>' + E(reg.name) + '</b>」执行 ' + E(label) + ' '
                + ({ set: '设为', scale: '乘以', offset: '加上' }[op] || op) + ' <b>' + (op === 'scale' ? val : fmtV(fid, val))
                + '</b>，影响 <b>' + r.affected + '</b> 站。<br>'
                + '区域指标：EEI ' + f1(r.before.eei) + ' → <b class="hl">' + f1(r.after.eei) + '</b>　'
                + '风险 ' + f1(r.before.risk) + ' → <b>' + f1(r.after.risk) + '</b>　'
                + '碳密度 ' + f1(r.before.carbon) + ' → <b>' + f1(r.after.carbon) + '</b>'
                + '<div class="src">变更 ' + r.change.id + ' 已写入台账 · 三维场景与全部图表面板已同步</div>',
              extra: { hop: '③ 后端写库', detail: '区域调数 → 覆盖层 + 台账 ' + r.change.id, ms: 0 }
            };
          });
        });
      });
    },

    data_correct: function (a) {
      var name = a.station || rgStationFromText(a.raw || '');
      var fid = a.field || rgFieldFromText(a.raw || '');
      if (!name) return { ok: false, html: '未识别站点名，请指明具体站点' };
      if (!fid) return { ok: false, html: '未识别字段，可指定 林地/降雪/气温/海拔 等' };
      return post('/api/station/correct', {
        name: name, field: fid, value: Number(a.value),
        reason: a.reason || '智能体指令', source: a.source || '智能体'
      }).then(function (r) {
        RG.delta = { before: r.before, after: r.after };
        return rgAfterWrite(r).then(function () {
          return {
            ok: true, html: '已把 <b>' + E(name) + '</b> 的 ' + E(r.change.fieldNm || fid) + ' 从 '
              + fmtV(fid, r.old) + ' 修正为 <b class="hl">' + fmtV(fid, r.new) + '</b>。'
              + '<br>全流域指标：EEI ' + f1(r.before.eei) + ' → <b>' + f1(r.after.eei) + '</b>，'
              + '风险 ' + f1(r.before.risk) + ' → <b>' + f1(r.after.risk) + '</b>'
              + '<div class="src">变更 ' + r.change.id + ' 已留痕，可撤销</div>',
            extra: { hop: '③ 后端写库', detail: '单站修正 → 台账 ' + r.change.id, ms: 0 }
          };
        });
      });
    },

    anomaly_scan: function () {
      return get('/api/anomalies').then(function (j) {
        if (!j.items.length) return { ok: true, html: '数据质量筛查完成：当前口径下没有命中规则的可疑值。' };
        var rows = j.items.map(function (a) {
          return '<tr><td>' + E(a.station) + '</td><td>' + E(a.fieldNm) + '</td><td>'
            + fmtV(a.field, a.value) + '</td><td>' + fmtV(a.field, a.suggest) + '</td><td>'
            + (a.dev > 0 ? '+' : '') + a.dev + '%</td><td>' + a.level + '</td></tr>';
        }).join('');
        return {
          ok: true, html: '筛查出 <b>' + j.items.length + '</b> 条<b>疑似</b>异常（统计离群 ≠ 数据错误，需人工确认）：'
            + '<table><tr><th>站点</th><th>字段</th><th>当前</th><th>邻域参照</th><th>偏差</th><th>级别</th></tr>'
            + rows + '</table><div class="src">' + E(j.method) + '；已人工核查 ' + j.dismissed + ' 条</div>'
        };
      });
    },

    change_log: function () {
      return get('/api/changes?limit=12').then(function (j) {
        if (!j.changes.length) return { ok: true, html: '台账为空，还没有任何人工修正记录。' };
        var kmap = { adjust: '区域调数', correct: '单站修正', reset: '区域回退', observe: '追加观测' };
        var rows = j.changes.map(function (c) {
          return '<tr><td>' + E(c.id) + '</td><td>' + E((c.t || '').slice(5, 16)) + '</td><td>'
            + E(kmap[c.kind] || c.kind) + '</td><td>' + E(c.regionName || '') + '</td><td>'
            + E(c.fieldNm || '') + '</td><td>' + (c.n || 0) + '</td><td>'
            + (c.undone ? '已撤销' : '生效') + '</td></tr>';
        }).join('');
        return {
          ok: true, html: '数据治理台账最近 <b>' + j.changes.length + '</b> 条（序列号 ' + j.seq + '）：'
            + '<table><tr><th>编号</th><th>时间</th><th>类型</th><th>区域</th><th>字段</th><th>站数</th><th>状态</th></tr>'
            + rows + '</table><div class="src">谁改的、改了什么、为什么改，全部可查；单条可撤销</div>'
        };
      });
    },

    change_undo: function (a) {
      var id = a.id || '';
      if (!id) return { ok: false, html: '请给出要撤销的变更编号（如 C3）' };
      return post('/api/changes/undo', { id: id }).then(function (r) {
        return rgAfterWrite(r).then(function () {
          return {
            ok: true, html: '已撤销变更 <b>' + E(id) + '</b>（' + E(r.change.fieldNm || '') + '，'
              + (r.change.n || 0) + ' 站）。<br>当前全流域 EEI <b>' + f1(r.mean.eei) + '</b>，风险 '
              + f1(r.mean.risk) + '，数值已回到修改前状态。'
          };
        });
      });
    },

    add_observation: function (a) {
      var name = a.station;
      var fid = a.field;
      if (!name || !fid) return { ok: false, html: '需要指定站点与字段' };
      return post('/api/observations', {
        station: name, field: fid, value: Number(a.value), t: a.t || '',
        source: a.source || '手工录入', note: a.note || '', apply: a.apply !== false
      }).then(function (r) {
        return rgAfterWrite(r).then(function () {
          return {
            ok: true, html: '已登记观测 <b>' + E(r.observation.id) + '</b>：' + E(name) + ' · '
              + E(r.observation.fieldNm) + ' = <b>' + fmtV(fid, r.observation.value) + '</b>（'
              + E(r.observation.t) + '，来源：' + E(r.observation.source) + '）'
              + (r.observation.applied ? '，并已设为当前有效值，指标同步重算。' : '，仅归档。')
              + '<div class="src">观测台账保留时间戳，为后续时间维度预留</div>'
          };
        });
      });
    }
  };

  if (window.AI_TOOL_IMPL) {
    Object.keys(TOOLS).forEach(function (k) { window.AI_TOOL_IMPL[k] = TOOLS[k]; });
  }

  /* 规则路由扩展：中文口语 → 治理工具链 */
  function rgPlan(qs) {
    var t = (qs || '').trim();
    if (!t) return null;
    var steps = [];
    if (/(有哪些区域|区域清单|区域列表|可选的区域)/.test(t)) return [{ t: 'region_list', a: {} }];
    if (/(变更台账|改了哪些|修改记录|修正记录|数据台账)/.test(t)) return [{ t: 'change_log', a: {} }];
    if (/(撤销|回滚|撤回)\s*(变更)?\s*C?\d+/i.test(t)) {
      var mm = t.match(/(C\d+|\d+)/);
      return [{ t: 'change_undo', a: { id: mm ? (/^C/i.test(mm[1]) ? mm[1] : 'C' + mm[1]) : '' } }];
    }
    if (/(异常|可疑|离群|数据质量|数据体检|筛查)/.test(t) && !/(修正|改成|调整)/.test(t))
      return [{ t: 'anomaly_scan', a: {} }];
    if (/(追加|补录|新增一条?观测|补测)/.test(t) && rgStationFromText(t)) {
      var fid0 = rgFieldFromText(t);
      var v0 = t.match(/(-?\d+(?:\.\d+)?)/);
      if (fid0 && v0) {
        return [{ t: 'add_observation', a: {
          station: rgStationFromText(t), field: fid0, value: parseFloat(v0[1]),
          t: new Date().toISOString().slice(0, 7), source: '手工录入', note: t.slice(0, 40)
        } }];
      }
    }
    /* 区域调数：出现区域名 + 字段 + 数值/幅度 */
    if (/(区域|流域|河段|上游|中游|下游|调|改|修正|上调|下调|提高|降低)/.test(t)) {
      var fid = rgFieldFromText(t);
      var chg = fid ? rgParseChange(t, fid) : null;
      var hasRegion = /(上游|中游|下游|全流域|整个流域|流域整体)/.test(t)
        || (RG.regions || []).some(function (r) { return r.id !== 'basin' && t.indexOf(r.name) >= 0; });
      if (fid && chg && hasRegion && !rgStationFromText(t)) {
        var regTxt = (t.match(/[\u4e00-\u9fa5]{2,8}(?:河段|区|库区|流域)/) || [])[0] || t;
        steps.push({ t: 'region_adjust', a: {
          region: regTxt, field: fid, op: chg.op, value: chg.value,
          reason: t.slice(0, 60), source: '智能体'
        } });
        return steps;
      }
      /* 单站修正 */
      var st = rgStationFromText(t);
      if (fid && st && chg) {
        if (chg.op !== 'set') {
          /* 单站用倍数时换算成绝对值 */
          var cur = null;
          (window.STATIONS || []).forEach(function (s) { if (s[0] === st) cur = s; });
          var base = cur ? (fid === 'lc.林地' ? cur[18] : fid === 'lc.草地灌丛' ? cur[19]
            : fid === 'lc.农田' ? cur[20] : fid === 'precip' ? cur[13] : fid === 'temp' ? cur[12]
            : fid === 'elev' ? cur[4] : null) : null;
          if (base != null) {
            var nv = chg.op === 'scale' ? base * chg.value : base + chg.value;
            chg = { op: 'set', value: nv };
          }
        }
        steps.push({ t: 'data_correct', a: {
          station: st, field: fid, value: chg.value, reason: t.slice(0, 60), source: '智能体'
        } });
        return steps;
      }
    }
    return null;
  }

  if (window.aiPlan) {
    var _origPlan = window.aiPlan;
    window.aiPlan = function (qs) {
      var extra = null;
      try { extra = rgPlan(qs); } catch (e) { extra = null; }
      var base = _origPlan(qs) || [];
      if (extra && extra.length) return extra.concat(base);
      return base;
    };
  }
  /* 让 LLM 规划也能识别这些写操作 */
  if (window.LLM_TOOLS) {
    window.LLM_TOOLS = window.LLM_TOOLS + '\n'
      + 'region_list {} 列出可选区域与区域指标\n'
      + 'region_adjust {"region":"中游河段","field":"lc.林地","op":"scale|set|offset","value":1.15,"reason":"…"} 区域级调数\n'
      + 'data_correct {"station":"巴塘","field":"precip","value":750,"reason":"…"} 单站修正\n'
      + 'anomaly_scan {} 数据质量筛查\n'
      + 'change_log {} 查数据修正台账\n'
      + 'change_undo {"id":"C3"} 撤销某次修正\n'
      + 'add_observation {"station":"巴塘","field":"precip","value":700,"t":"2026-10","source":"野外补测"} 追加观测\n'
      + '字段可用：elev/slope/temp/precip/lc.林地/lc.草地灌丛/lc.农田/lc.建成区/lc.裸地/lc.水体/lc.湿地';
  }

  /* 打开模块时自动预加载一次（后台静默，不阻塞其他模块） */
  setTimeout(function () {
    get('/api/regions').then(function (j) {
      RG.regions = j.regions || []; RG.fields = j.fields || []; RG.online = true;
    }).catch(function () {});
  }, 1200);
})();
