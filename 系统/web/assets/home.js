/* ============================================================================
   态势总览（登录后默认页）
   ----------------------------------------------------------------------------
   这一页只干一件事：把「流域现在什么状况、哪里在恶化、先查哪、数据有多可信」
   用一屏说清。所有数字来自 /api/conclusion，与评估页、预警页、巡检页同一个引擎，
   不存在"总览一套数、详情另一套数"。
   ========================================================================== */
(function () {
  'use strict';

  var H = { d: null, token: null, busy: false };

  function q(id) { return document.getElementById(id); }
  function E(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function num(v, n) {
    var x = Number(v);
    return isFinite(x) ? x.toFixed(n == null ? 1 : n) : '—';
  }
  function gradeCol(g) {
    return g === 'A' ? '#4ade80' : g === 'B' ? '#a3e635' : g === 'C' ? '#ffd48a' : '#ff8a8a';
  }

  /* 站点飞行：与「生态评估」「风险预警」共用同一个函数，保证定位一致 */
  function fly(name) {
    if (!window.STATIONS) return;
    for (var i = 0; i < window.STATIONS.length; i++) {
      if (window.STATIONS[i][0] === name) {
        if (window.flyToStationIdx) window.flyToStationIdx(i);
        return;
      }
    }
  }

  /* ---------- 结论卡 ---------- */
  function cardHtml(d) {
    var k = d.kpi;
    return '<div style="position:relative;overflow:hidden;border-radius:10px;padding:12px 13px 11px;'
      + 'background:linear-gradient(135deg,rgba(53,224,184,.13),rgba(53,224,184,.02) 62%,rgba(255,122,217,.06));'
      + 'border:1px solid rgba(53,224,184,.30)">'
      /* 右上角年份水位线装饰，不承载信息，只做视觉锚点 */
      + '<div style="position:absolute;right:-18px;top:-24px;width:96px;height:96px;border-radius:50%;'
      + 'background:radial-gradient(circle,rgba(53,224,184,.20),transparent 68%)"></div>'
      + '<div style="display:flex;align-items:baseline;gap:9px">'
      + '<span style="font-family:Consolas,monospace;font-size:34px;line-height:1;color:#8df3de;'
      + 'text-shadow:0 0 18px rgba(53,224,184,.45)">' + num(k.eei, 1) + '</span>'
      + '<span style="font-size:10px;color:#9fb8bb;letter-spacing:1px">EEI</span>'
      + '<span style="font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;'
      + 'color:' + gradeCol(k.grade) + ';border:1px solid ' + gradeCol(k.grade) + '55;'
      + 'background:' + gradeCol(k.grade) + '14">' + E(k.grade) + ' 级</span>'
      + '<span style="margin-left:auto;font-size:9px;color:#7d979b">综合风险 '
      + num(k.risk, 1) + '</span></div>'
      + '<div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">'
      + chip('高风险 ' + k.high + ' 站', '#ff8a8a')
      + chip('退化 ' + k.declining + ' 站', '#ffb03a')
      + chip('改善 ' + k.improving + ' 站', '#4ade80')
      + chip('站点 20', '#7fe3cd') + '</div>'
      + '<div style="font-size:10.5px;line-height:1.9;color:#cfe9e2;margin-top:9px">' + E(d.text) + '</div>'
      + evStrip(d)
      + '<div style="font-size:8.5px;color:#6f8f96;margin-top:7px;font-family:Consolas,monospace;'
      + 'display:flex;gap:8px;flex-wrap:wrap">'
      + '<span>' + E((d.generated || '').slice(5, 16)) + '</span>'
      + '<span>指纹 #' + E(String(d.dataToken || '').slice(0, 8)) + '</span></div>'
      + '</div>';
  }

  /* 证据分级：塞进结论卡里，第一屏就能看见"这些数有多可信"，不用往下翻 */
  function evStrip(d) {
    var c = d.confidence || {};
    var tot = (c.A || 0) + (c.B || 0) + (c.C || 0) + (c.D || 0) || 1;
    var cols = { A: '#4ade80', B: '#7fe3cd', C: '#7ab8ff', D: '#ffb03a' };
    var nms = { A: '实测', B: '模型', C: '遥感', D: '代理' };
    var bar = ['A', 'B', 'C', 'D'].map(function (k) {
      var n = c[k] || 0;
      return '<div title="' + nms[k] + ' ' + n + ' 项" style="flex:' + (n || 0.001) + ';height:5px;'
        + 'background:' + cols[k] + ';opacity:' + (n ? .85 : .12) + '"></div>';
    }).join('');
    return '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed rgba(53,224,184,.18)">'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
      + '<span style="font-size:8.5px;color:#7d979b;letter-spacing:.5px">证据分级</span>'
      + '<span class="hx-ev" style="margin-left:auto;font-size:8.5px;color:#7fe3cd;cursor:pointer">'
      + '逐项出处 →</span></div>'
      + '<div style="display:flex;gap:2px;border-radius:3px;overflow:hidden;margin-bottom:4px">' + bar + '</div>'
      + '<div style="display:flex;gap:9px;flex-wrap:wrap;font-size:8px;font-family:Consolas,monospace">'
      + ['A', 'B', 'C', 'D'].map(function (k) {
        return '<span style="color:' + cols[k] + '">' + k + ' ' + nms[k] + ' ' + (c[k] || 0) + '</span>';
      }).join('') + '</div>'
      + '<div style="font-size:8px;color:#5f8c86;line-height:1.6;margin-top:3px">'
      + 'D 级 ' + (c.D || 0) + ' 项尚无真值校验，论文须注明口径</div></div>';
  }
  function chip(t, c) {
    return '<span style="font-size:9px;padding:1px 6px;border-radius:10px;font-family:Consolas,monospace;'
      + 'color:' + c + ';background:' + c + '16;border:1px solid ' + c + '33">' + E(t) + '</span>';
  }

  /* ---------- 三大河段 ---------- */
  function segHtml(d) {
    var seg = d.segments || {};
    var ks = Object.keys(seg);
    if (!ks.length) return '';
    var vals = ks.map(function (k) { return seg[k].eei; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var span = Math.max(1, hi - lo);
    var order = { '上游高寒峡谷': 1, '中游山原峡谷': 2, '下游库区河谷': 3 };
    ks.sort(function (a, b) { return (order[a] || 9) - (order[b] || 9); });
    var rows = ks.map(function (k) {
      var v = seg[k];
      var w = 30 + 62 * (v.eei - lo) / span;         /* 相对宽度，只用于对比，封顶 92% */
      var col = gradeCol(v.eei >= 60 ? 'A' : v.eei >= 55 ? 'B' : v.eei >= 45 ? 'C' : 'D');
      return '<div style="margin-bottom:7px">'
        + '<div style="display:flex;align-items:baseline;font-size:9.5px;color:#bcd6d2;margin-bottom:3px">'
        + '<span>' + E(k) + '</span>'
        + '<span style="margin-left:auto;font-family:Consolas,monospace;font-size:10.5px;color:' + col + '">'
        + num(v.eei, 1) + '</span>'
        + '<span style="color:#6f8f96;font-size:8.5px;margin-left:5px;width:30px;text-align:right">n=' + v.n + '</span></div>'
        + '<div style="height:5px;border-radius:3px;background:rgba(255,255,255,.055)">'
        + '<div style="height:100%;width:' + w.toFixed(1) + '%;border-radius:3px;'
        + 'background:linear-gradient(90deg,' + col + '77,' + col + ');'
        + 'box-shadow:0 0 6px ' + col + '55"></div></div></div>';
    }).join('');
    return '<div class="sec-lab">干流三段 · 空间分异</div>' + rows
      + '<div style="font-size:8.5px;color:#6f8f96;line-height:1.7">'
      + '最稳与最弱相差 ' + num(hi - lo, 1) + ' 分；条长按相对差绘制，非绝对刻度。</div>';
  }

  /* ---------- 植被趋势 ---------- */
  function trendHtml(d) {
    var dn = d.declining || [];
    if (!dn.length) return '';
    return '<div class="sec-lab">11 年 NDVI 趋势（Sen + MK 检验）</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:5px">'
      + dn.map(function (x) {
        return '<span class="hx-st" data-st="' + E(x.name) + '" style="cursor:pointer;'
          + 'font-size:9.5px;padding:2px 7px;border-radius:10px;font-family:Consolas,monospace;'
          + 'color:#ff9b9b;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.28)">'
          + E(x.name) + ' ' + num(x.sen * 1000, 2) + '‰</span>';
      }).join('') + '</div>'
      + '<div style="font-size:8.5px;color:#6f8f96;margin-top:5px;line-height:1.7">'
      + '单位：NDVI/年（‰）；仅列 MK 检验 p&lt;0.05 的显著下降站，点站点名可定位飞行。</div>';
  }

  /* ---------- 优先核查 ---------- */
  function priHtml(d) {
    var ps = d.priority || [];
    if (!ps.length) return '';
    return '<div class="sec-lab">优先核查（风险 0.55 + 趋势 0.28 + 待复核 0.17）</div>'
      + ps.map(function (p, i) {
        return '<div class="hx-pri" data-st="' + E(p.name) + '" style="cursor:pointer;'
          + 'display:flex;gap:8px;padding:6px 8px;margin-bottom:4px;border-radius:6px;'
          + 'background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.055)">'
          + '<span style="font-family:Consolas,monospace;font-size:13px;color:#5f8c86;width:12px">'
          + (i + 1) + '</span>'
          + '<span style="flex:1;min-width:0">'
          + '<span style="font-size:11px;color:#e6fbf5">' + E(p.name) + '</span>'
          + '<span style="font-family:Consolas,monospace;font-size:9px;color:#7fe3cd;margin-left:6px">'
          + num(p.score, 2) + '</span>'
          + '<div style="font-size:8.5px;color:#7d979b;line-height:1.6;margin-top:2px">'
          + E((p.reasons || []).join(' · ')) + '</div></span></div>';
      }).join('');
  }

  /* ---------- 分区聚合 ---------- */
  function zoneHtml(d) {
    var zs = (d.zones_min3 && d.zones_min3.length) ? d.zones_min3 : (d.zones || []);
    if (!zs.length) return '';
    return '<div class="sec-lab">分区聚合 · 20 站如何代表流域</div>'
      + '<div style="font-size:8.5px;color:#6f8f96;line-height:1.7;margin-bottom:5px">'
      + '按气候—地貌分区把 20 个点归并为 7 个统计单元，n 为站数。'
      + 'n 越小，该区结论越依赖单点，引用时须注明。</div>'
      + zs.map(function (z) {
        return '<div style="display:flex;align-items:baseline;font-size:9.5px;padding:3px 0;'
          + 'border-bottom:1px dashed rgba(255,255,255,.05)">'
          + '<span style="color:#bcd6d2">' + E(z.name) + '</span>'
          + '<span style="color:#5f8c86;font-size:8.5px;margin-left:5px">n=' + z.n + '</span>'
          + (z.merged ? '<span style="font-size:8px;color:#7fe3cd;border:1px solid rgba(53,224,184,.35);'
              + 'border-radius:3px;padding:0 3px;margin-left:4px">合并</span>' : '')
          + '<span style="margin-left:auto;font-family:Consolas,monospace;color:'
          + gradeCol(z.grade) + '">' + num(z.eei, 1) + '</span>'
          + '<span style="font-family:Consolas,monospace;font-size:8.5px;color:#7d979b;'
          + 'margin-left:8px;width:44px;text-align:right">R ' + num(z.risk, 1) + '</span></div>';
      }).join('');
  }

  /* ---------- 指标体检 + 复现包 ---------- */
  function diagHtml(g) {
    if (!g || !g.ok) return '';
    var ext = (g.external || [])[0] || {};
    var worst = (g.pairs || [])[0] || {};
    var lowR = ext.r != null && Math.abs(ext.r) < 0.5;
    return '<div class="sec-lab">指标体检 · 自洽性检查</div>'
      + '<div style="font-size:9.5px;line-height:1.85;color:#bcd6d2">'
      + '<div>· 综合指数与 ' + E((ext.nm || '').split('（')[0]) + ' 相关 '
      + '<b style="color:' + (lowR ? '#ffb03a' : '#7fe3cd') + ';font-family:Consolas,monospace">r = '
      + num(ext.r, 2) + '</b>（n=' + (ext.n || 0) + '）'
      + (lowR ? '，说明 EEI 由下垫面结构主导，与遥感绿度是两套口径' : '') + '</div>'
      + (worst.a ? '<div>· 维度共线：' + E(worst.a) + ' 与 ' + E(worst.b) + ' r = '
          + '<b style="font-family:Consolas,monospace">' + num(worst.r, 2) + '</b>，存在重复计权</div>' : '')
      + '<div>· PCA 第一主成分解释 <b style="font-family:Consolas,monospace">'
      + Math.round((g.explained || 0) * 100) + '%</b>；客观权重与主观权重排序一致性 ρ = '
      + '<b style="color:#7fe3cd;font-family:Consolas,monospace">' + num(g.spearman, 2) + '</b>'
      + '（' + (g.spearman >= 0.9 ? '结论对权重不敏感' : '结论对权重较敏感') + '）</div>'
      + (g.coverage && g.coverage.min ? '<div>· NDVI 有效观测占比 ' + num(g.coverage.min.ratio * 100, 1)
          + '–' + num(g.coverage.mean * 100, 1) + '%，最低站 ' + E(g.coverage.min.name) + '</div>' : '')
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-top:6px">'
      + '<span class="hx-repro" style="flex:1;text-align:center;cursor:pointer;font-size:9px;padding:4px;'
      + 'border-radius:5px;color:#7fe3cd;border:1px solid rgba(53,224,184,.28);'
      + 'background:rgba(53,224,184,.06)">⬇ 导出复现包</span>'
      + '<span class="hx-diag" style="flex:1;text-align:center;cursor:pointer;font-size:9px;padding:4px;'
      + 'border-radius:5px;color:#9fb8bb;border:1px solid rgba(255,255,255,.12)">权重对照 →</span></div>';
  }

  function loadDiag() {
    var box = q('hxDiag');
    if (!box) return;
    window.dhFetch('/api/diagnose', 12000).then(function (g) {
      if (!box || !g || !g.ok) return;
      box.innerHTML = diagHtml(g);
      var b = box.querySelector('.hx-diag');
      if (b) b.onclick = function () { showDiag(g); };
      var r = box.querySelector('.hx-repro');
      if (r) r.onclick = downloadRepro;
    }).catch(function () {});
  }

  function showDiag(g) {
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(3,10,14,.72);'
      + 'display:flex;align-items:center;justify-content:center;padding:24px';
    var rows = (g.dims || []).map(function (x) {
      return '<tr><td style="padding:4px 6px;border-bottom:1px dashed rgba(255,255,255,.05)">' + E(x.nm) + '</td>'
        + '<td style="padding:4px 6px;text-align:right;font-family:Consolas,monospace">' + x.subj + '</td>'
        + '<td style="padding:4px 6px;text-align:right;font-family:Consolas,monospace;color:#7fe3cd">' + num(x.obj, 1) + '</td>'
        + '<td style="padding:4px 6px;text-align:right;font-family:Consolas,monospace;color:'
        + (x.load < 0 ? '#ff9b9b' : '#9fb8bb') + '">' + num(x.load, 3) + '</td></tr>';
    }).join('');
    mask.innerHTML = '<div style="width:min(620px,94vw);max-height:82vh;overflow:auto;background:#0b1a21;'
      + 'border:1px solid rgba(53,224,184,.28);border-radius:10px;padding:16px 18px">'
      + '<div style="font-size:12px;color:#eafffa;margin-bottom:8px">权重对照 · 主观 vs 客观（PCA）</div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:9.5px">'
      + '<thead><tr style="color:#7d979b;text-align:left"><th style="padding:4px 6px">维度</th>'
      + '<th style="padding:4px 6px;text-align:right">主观</th><th style="padding:4px 6px;text-align:right">客观</th>'
      + '<th style="padding:4px 6px;text-align:right">PC1 载荷</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div style="font-size:8.5px;color:#6f8f96;line-height:1.75;margin-top:8px">' + E(g.note || '') + '</div>'
      + '<div class="hx-close" style="text-align:center;margin-top:10px;cursor:pointer;font-size:10px;color:#7fe3cd">关闭</div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || (e.target.className || '').indexOf('hx-close') >= 0) mask.parentNode.removeChild(mask);
    });
  }

  function downloadRepro() {
    window.dhFetch('/api/repro', 20000).then(function (d) {
      if (!d || !d.ok) { window.toast && window.toast('复现包生成失败', 'warn', '!'); return; }
      var blob = new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'jinsha_repro_' + d.run + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      window.toast && window.toast('复现包已导出 · run ' + d.run, 'ok', '⬇');
    }).catch(function () { window.toast && window.toast('后端不可达', 'warn', '!'); });
  }

  /* ---------- 快捷入口 ---------- */
  function navHtml() {
    var btns = [['region', '区域治理'], ['patrol', '巡检建议'], ['warn', '风险预警'], ['assess', '智能评估']];
    return '<div class="sec-lab">继续处理</div><div style="display:flex;flex-wrap:wrap;gap:6px">'
      + btns.map(function (b) {
        return '<span class="hx-go" data-go="' + b[0] + '" style="cursor:pointer;font-size:9.5px;'
          + 'padding:4px 9px;border-radius:12px;color:#9fe6d8;background:rgba(53,224,184,.08);'
          + 'border:1px solid rgba(53,224,184,.22)">' + b[1] + '</span>';
      }).join('') + '</div>';
  }

  /* ---------- 证据详情弹层（用原生 dialog 之外的轻量层，避免与既有 z-index 冲突） ---------- */
  function showEvidence() {
    if (!H.d) return;
    var old = q('hxEvMask');
    if (old) old.parentNode.removeChild(old);
    var items = H.d.evidence || [];
    var cols = { A: '#4ade80', B: '#7fe3cd', C: '#7ab8ff', D: '#ffb03a' };
    var mask = document.createElement('div');
    mask.id = 'hxEvMask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(3,10,14,.72);'
      + 'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px';
    mask.innerHTML = '<div style="width:min(760px,94vw);max-height:82vh;overflow:auto;'
      + 'background:#0b1a21;border:1px solid rgba(53,224,184,.28);border-radius:10px;padding:16px 18px">'
      + '<div style="display:flex;align-items:center;margin-bottom:10px">'
      + '<b style="font-size:13px;color:#eafffa;letter-spacing:1px">指标证据级别 · 逐项出处</b>'
      + '<span class="hx-close" style="margin-left:auto;cursor:pointer;color:#7d979b;font-size:16px">×</span></div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:9.5px;line-height:1.65">'
      + '<thead><tr style="color:#7d979b;text-align:left">'
      + '<th style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.1)">指标</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.1);width:52px">级别</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.1)">来源</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.1)">口径</th>'
      + '<th style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.1)">验证状态</th></tr></thead>'
      + '<tbody>' + items.map(function (x) {
        return '<tr><td style="padding:4px 6px;color:#dff7f1;border-bottom:1px dashed rgba(255,255,255,.05)">'
          + E(x.ind) + '</td>'
          + '<td style="padding:4px 6px;border-bottom:1px dashed rgba(255,255,255,.05)">'
          + '<b style="color:' + cols[x.lv] + '">' + x.lv + '</b></td>'
          + '<td style="padding:4px 6px;color:#bcd6d2;border-bottom:1px dashed rgba(255,255,255,.05)">'
          + E(x.src) + '</td>'
          + '<td style="padding:4px 6px;color:#9fb8bb;border-bottom:1px dashed rgba(255,255,255,.05)">'
          + E(x.basis) + '</td>'
          + '<td style="padding:4px 6px;color:#8fb0ad;border-bottom:1px dashed rgba(255,255,255,.05)">'
          + E(x.check) + '</td></tr>';
      }).join('') + '</tbody></table>'
      + '<div style="font-size:8.5px;color:#6f8f96;margin-top:9px;line-height:1.7">'
      + 'A 站点实测｜B 可复算的模型或再分析｜C 卫星反演｜D 无验证的经验系数或结构代理。'
      + '本表与界面徽标、CSV 导出同源（server.py 中 EVIDENCE 常量），改一处三处同步。</div>'
      + boundaryHtml() + '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      if (e.target === mask || (e.target.className || '').indexOf('hx-close') >= 0) {
        mask.parentNode.removeChild(mask);
      }
    });
  }

  /* 对外暴露：其它模块或深链（#evidence）可直接打开证据表 */
  window.homeEvidence = showEvidence;

  /* 能力边界：写清"这套方法能回答什么、不能回答什么"，比埋一条 D 级更管用 */
  function boundaryHtml() {
    var rows = [
      ['真实遥感指标计算', '已有', '8 个指标 · 3.3 万行 · 2000–2025', '#4ade80'],
      ['多源交叉验证', '已记录', '气温 r=0.93、降水 r=0.89，偏差已归因', '#7fe3cd'],
      ['独立地面/样地验证', '尚未完成', '无滑坡编目、无样地碳库、无水质实测', '#ffb03a'],
      ['全流域长时序外推', '尚不支持', '结论为 20 个站点尺度，非像元尺度', '#ff8a8a']
    ];
    return '<div style="margin-top:11px;padding-top:9px;border-top:1px dashed rgba(53,224,184,.18)">'
      + '<div style="font-size:8.5px;color:#7d979b;letter-spacing:.5px;margin-bottom:5px">能力边界 · 能回答与不能回答</div>'
      + rows.map(function (r) {
        return '<div style="display:flex;gap:7px;font-size:9px;line-height:1.8;align-items:baseline">'
          + '<span style="width:96px;color:#bcd6d2;flex:0 0 auto">' + r[0] + '</span>'
          + '<span style="width:52px;flex:0 0 auto;color:' + r[3] + ';font-size:8.5px">' + r[1] + '</span>'
          + '<span style="color:#7d979b;flex:1">' + r[2] + '</span></div>';
      }).join('')
      + '<div style="font-size:8.5px;color:#6f8f96;margin-top:5px;line-height:1.7">'
      + '不以内部一致性代替外部验证：交叉验证只证明数据接入无误，不证明模型正确。</div></div>';
  }

  /* ---------- 主渲染 ---------- */
  window.homeRender = function () {
    var B = q('phBody');
    if (!B) return;
    if (!H.d) {
      B.innerHTML = '<div class="mod-note">正在汇总流域态势…</div>';
    }
    H.busy = true;
    window.dhFetch('/api/conclusion', 12000).then(function (d) {
      H.busy = false;
      if (!d || !d.ok) {
        B.innerHTML = '<div class="mod-note">结论生成失败：' + E((d && d.error) || '后端无响应')
          + '<br>确认服务已启动后重进本页。</div>';
        return;
      }
      H.d = d;
      H.token = d.dataToken;
      B.innerHTML = cardHtml(d) + segHtml(d) + trendHtml(d) + priHtml(d)
        + zoneHtml(d) + '<div id="hxDiag"></div>' + navHtml()
        + '<div style="font-size:8.5px;color:#5d7a80;margin-top:10px;line-height:1.75">'
        + '本页所有数字由 /api/conclusion 一次算出，与生态评估、风险预警、巡检建议同源；'
        + '数据变动后 20 秒内自动重算。</div>';
      bind();
      loadDiag();
      if (location.hash === '#evidence') setTimeout(showEvidence, 260);
    }).catch(function (e) {
      H.busy = false;
      B.innerHTML = '<div class="mod-note">无法连接后端（' + E(e.message || e) + '）</div>';
    });
  };

  function bind() {
    var B = q('phBody');
    if (!B) return;
    B.querySelectorAll('.hx-st,.hx-pri').forEach(function (el) {
      el.onclick = function () { fly(el.dataset.st); };
    });
    B.querySelectorAll('.hx-go').forEach(function (el) {
      el.onclick = function () { if (window.switchModule) window.switchModule(el.dataset.go); };
    });
    B.querySelectorAll('.hx-ev').forEach(function (el) {
      el.onclick = showEvidence;
    });
  }

  /* 指纹轮询：只有数字真的变了才重绘，避免每 20 秒闪一次 */
  setInterval(function () {
    if (!window.G || window.G.curPh !== 'home') return;
    if (H.busy) return;
    window.dhFetch('/api/data/version', 6000).then(function (j) {
      if (j && j.ok && H.token && j.token !== H.token) {
        window.toast && window.toast('指标已重算，态势总览已刷新', 'ok', '⟳');
        window.homeRender();
      }
    }).catch(function () {});
  }, 20000);
})();
