(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const levels = [
    { name: '高风险', label: '高', color: '#ff757e' },
    { name: '中风险', label: '中', color: '#ffbc68' },
    { name: '低风险', label: '低', color: '#5de1b3' }
  ];
  const segments = [
    ['上游高寒峡谷', '上游', 'upstream'],
    ['中游山原峡谷', '中游', 'midstream'],
    ['下游库区河谷', '下游', 'downstream']
  ];
  const dimensions = [
    ['habitat', '生境', 1, ''],
    ['biodiversity', '多样性', 1, ''],
    ['water', '水源涵养', 1000, ' mm'],
    ['soil', '土壤保持', 40, ' t/ha'],
    ['climate', '气候调节', 1, ''],
    ['resilience', '生态韧性', 1, ''],
    ['esv', '服务价值', 4, ' 万元'],
    ['disturbance', '低干扰', 1, '']
  ];
  let station = null;
  let items = [];
  let radar = null;
  let latestToken = null;
  let loading = false;
  let dock = '';

  function make(tag, cls, value) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function setText(id, text) {
    byId(id).textContent = text;
  }

  function number(value, digits) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  }

  function query(path) {
    return window.dhFetch(path, 12000);
  }

  function zoomToStation(name) {
    if (window.JinshaMapTools) window.JinshaMapTools.focusStation(name);
  }

  function openStations(risk) {
    if (window.JinshaMapTools) window.JinshaMapTools.open('stations', risk);
  }

  function displayModule(id) {
    if (document.body.classList.contains('maxmap')) {
      document.body.classList.remove('maxmap');
      byId('btnMax').setAttribute('aria-pressed', 'false');
    }
    window.switchModule(id);
    if (document.body.dataset.workspaceModule === 'map' && narrow.matches) {
      document.body.classList.add('coll-l');
    }
    resizeWorkspace();
  }

  function makePairs(values, style) {
    const list = make('dl', style || 'jr-data-pairs');
    values.forEach(([label, value]) => {
      const pair = make('div');
      pair.append(make('dt', '', label), make('dd', '', value));
      list.append(pair);
    });
    return list;
  }

  function makeBar(name, label, color, percent, description, action) {
    const button = make('button', 'jr-bar-row');
    button.type = 'button';
    button.setAttribute('aria-label', description);
    button.title = description;
    const track = make('span', 'jr-track');
    const bar = make('i');
    bar.style.setProperty('--fill', Math.min(100, Math.max(0, percent)) + '%');
    bar.style.setProperty('--color', color);
    track.append(bar);
    button.append(make('span', '', name), track, make('strong', '', label));
    button.onclick = action;
    return button;
  }

  function renderRisks() {
    const stations = window.STATIONS || [];
    const count = byId('jrStationCount');
    count.textContent = stations.length ? String(stations.length) : '—';
    const online = window.DH && window.DH.online;
    setText('jrStationSource', online ? '本地站点台账' : '内置站点快照');
    byId('rcRisk').replaceChildren(...levels.map(level => {
      const n = stations.filter(row => row[6] === level.name).length;
      return makeBar(level.label, String(n), level.color, stations.length ? n / stations.length * 100 : 0,
        level.name + ' ' + n + ' 站，查看清单', () => openStations(level.name));
    }));
  }

  function updateConclusion(data) {
    const kpi = data.kpi || {};
    setText('ksEei', number(kpi.eei, 1));
    setText('ksGrade', kpi.grade ? kpi.grade + ' 级 · 站点平均' : '站点平均 · 0–100');
    setText('ksRisk', number(kpi.risk, 1));
    setText('ksHigh', number(kpi.high, 0));
    setText('ksDec', number(kpi.declining, 0));
    const summary = String(data.text || '').split('。').slice(1, 3).filter(Boolean);
    setText('jrBasinBrief', summary.length ? summary.join('。') + '。' : (data.text || '暂无流域评估摘要'));
    const priority = (data.priority || []).slice(0, 3);
    if (priority.length) {
      byId('jrPriority').replaceChildren(...priority.map((entry, index) => {
        const button = make('button', 'jr-priority-row');
        button.type = 'button';
        const detail = make('span', '', entry.name);
        detail.append(make('small', '', (entry.reasons || []).slice(0, 2).join(' · ')));
        button.append(make('span', 'jr-rank', String(index + 1).padStart(2, '0')), detail,
          make('span', 'jr-rating', number(entry.score, 2)));
        button.title = '定位' + entry.name + ' · 巡检优先分 ' + number(entry.score, 2);
        button.onclick = () => zoomToStation(entry.name);
        return button;
      }));
    } else setText('jrPriority', '暂无巡检建议');

    const rows = segments.flatMap(([key, label, view]) => {
      const record = (data.segments || {})[key];
      if (!record) return [];
      const detail = label + ' EEI ' + number(record.eei, 1) + '，风险 ' + number(record.risk, 1) + '，' + record.n + ' 站，查看河段';
      return [makeBar(label, number(record.eei, 1), '#71cef5', Number(record.eei) || 0, detail,
        () => { if (window.camCtl) window.flyToView(view); })];
    });
    byId('rcSeg').replaceChildren(...rows);
    byId('jrSegmentStatus').hidden = rows.length > 0;
    if (!rows.length) setText('jrSegmentStatus', '暂无分段评估');
  }

  function renderRadar() {
    const el = byId('rcRadar');
    if (!window.echarts || !items.length || !el.clientWidth) return;
    const values = dimensions.map(([key, , max]) => {
      const sample = items.filter(row => row[key] !== null && row[key] !== undefined && Number.isFinite(Number(row[key])));
      if (!sample.length) return 0;
      const average = sample.reduce((sum, row) => sum + Number(row[key]), 0) / sample.length;
      return Math.min(1, Math.max(0, key === 'disturbance' ? 1 - average : average / max));
    });
    if (!radar) radar = window.echarts.init(el, null, { renderer: 'canvas' });
    radar.setOption({
      animation: false,
      radar: {
        indicator: dimensions.map(([, name]) => ({ name, max: 1 })),
        radius: '56%', center: ['50%', '52%'], splitNumber: 4,
        axisNameGap: 6, axisName: { color: '#acc6dd', fontSize: 10 },
        axisLine: { lineStyle: { color: '#34516d' } },
        splitLine: { lineStyle: { color: '#2b4761' } },
        splitArea: { areaStyle: { color: ['#111d2e', '#15263a'] } }
      },
      series: [{
        type: 'radar', data: [{ name: '站点平均', value: values.map(n => +n.toFixed(3)) }],
        symbol: 'circle', symbolSize: 4, lineStyle: { color: '#75e3cf', width: 2 },
        itemStyle: { color: '#bcf7eb' }, areaStyle: { color: '#63d9cc', opacity: .24 }
      }],
      tooltip: { confine: true, trigger: 'item', textStyle: { fontSize: 10 } }
    });
    byId('jrRadarStatus').hidden = true;
  }

  function renderStationAssessment() {
    if (!station) return;
    const root = byId('jrStationAssessment');
    const item = items.find(row => row.name === station[0]);
    if (!item) {
      root.textContent = loading ? '正在读取站点评估' : '站点评估暂不可用';
      return;
    }
    const rows = dimensions.map(([key, name, , unit]) => [
      key === 'disturbance' ? '人类干扰' : name,
      number(item[key], unit ? 1 : 3) + unit
    ]);
    root.replaceChildren(
      makePairs([['EEI / 100', number(item.eei, 1)], ['等级', item.grade || '—']]),
      makePairs(rows, 'jr-station-dim'),
      make('p', 'jr-station-note', '来源：站点地形、气候及土地覆盖派生指标。')
    );
  }

  function selectStation(value, notify) {
    if (!value) {
      station = null;
      byId('jrStationDetail').hidden = true;
      byId('jrBasinInspector').hidden = false;
      setText('jrInspectorTitle', '流域分析');
      if (notify) document.dispatchEvent(new CustomEvent('jinsha:station', { detail: null, bubbles: true }));
      renderRadar();
      resizeWorkspace();
      return;
    }
    station = value;
    setText('jrInspectorTitle', '站点分析');
    setText('sbName', value[0]);
    const pill = byId('sbRisk');
    pill.textContent = value[6] || '风险待评估';
    pill.style.color = (levels.find(level => level.name === value[6]) || {}).color || '#b6c9d9';
    byId('sbRows').replaceChildren(
      make('p', 'jr-station-note', [value[5], value[10]].filter(Boolean).join(' · ')),
      makePairs([
        ['海拔', number(value[4], 0) + ' m'],
        ['综合风险', number(value[21], 1)],
        ['植被覆盖', Number.isFinite(value[9]) ? number(value[9] * 100, 0) + '%' : '—'],
        ['碳密度', number(value[8], 1) + ' t/ha']
      ]),
      make('p', 'jr-station-note', (window.SC_ADVICE || {})[value[6]] || '可在智能评估查看指标口径与证据。')
    );
    byId('jrStationDetail').hidden = false;
    byId('jrBasinInspector').hidden = true;
    document.body.classList.remove('coll-r');
    if (narrow.matches) document.body.classList.add('coll-l');
    renderStationAssessment();
    if (notify) document.dispatchEvent(new CustomEvent('jinsha:station', { detail: value, bubbles: true }));
    resizeWorkspace();
  }

  async function loadSummary() {
    if (loading) return;
    loading = true;
    try {
      await Promise.allSettled([
        query('/api/conclusion').then(data => {
          if (!data.ok) throw new Error(data.error || '无数据');
          updateConclusion(data);
          latestToken = data.dataToken || latestToken;
        }).catch(() => {
          if (!latestToken) {
            setText('jrBasinBrief', '流域评估暂不可用。可继续浏览本地地形和站点。');
            setText('jrPriority', '暂无巡检依据');
            setText('jrSegmentStatus', '分段数据暂不可用');
          }
        }),
        query('/api/eco-services').then(data => {
          if (!data.ok) throw new Error(data.error || '无数据');
          items = data.items || [];
          renderRadar();
        }).catch(() => {
          if (!items.length) setText('jrRadarStatus', '评估数据暂不可用');
        })
      ]);
    } finally {
      loading = false;
      renderStationAssessment();
    }
  }

  function loadClimateKpi() {
    query('/api/data/climate_trend').then(rows => {
      const trend = Array.isArray(rows) && rows.find(row => row.station === '流域面平均' && row.metric === 'temp_c');
      if (!trend) return;
      const slope = number(trend.slope, 3);
      const value = (Number(trend.slope) > 0 ? '+' : '') + slope;
      byId('ksClim').replaceChildren(document.createTextNode(value), make('small', '', '°C/年'));
      if (trend.trend) setText('ksClimS', '1990–2025 · ' + trend.trend);
    }).catch(() => {});
  }

  let pendingResize = 0;
  function resizeWorkspace() {
    cancelAnimationFrame(pendingResize);
    pendingResize = requestAnimationFrame(() => {
      if (window.renderer && window.camera && byId('viewPane').clientWidth) {
        window.resize();
      }
      if (radar && byId('rcRadar').clientWidth) radar.resize();
      else renderRadar();
    });
  }

  const narrow = window.matchMedia('(max-width: 940px)');

  function togglePanel(side) {
    const body = document.body;
    const opening = body.classList.contains('coll-' + side);
    body.classList.toggle('coll-' + side, !opening);
    if (opening && narrow.matches) body.classList.add('coll-' + (side === 'l' ? 'r' : 'l'));
    resizeWorkspace();
  }

  function setDock(tab) {
    dock = dock === tab ? '' : tab;
    document.body.classList.toggle('dockhide', !dock);
    byId('bottomRow').querySelector('.prof').hidden = dock !== 'profile';
    byId('bottomRow').querySelector('.sim').hidden = dock !== 'simulation';
    document.querySelectorAll('[data-jr-dock]').forEach(button => {
      button.setAttribute('aria-expanded', String(dock === button.dataset.jrDock));
    });
    resizeWorkspace();
  }

  function wireMapSize() {
    const splitter = byId('jrRightSplit');
    const layout = byId('layout');
    splitter.addEventListener('pointerdown', event => {
      splitter.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    splitter.addEventListener('pointermove', event => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      const bounds = layout.getBoundingClientRect();
      const width = Math.max(207, Math.min(bounds.width * .33, bounds.right - event.clientX - 5));
      layout.style.setProperty('--jr-right-width', width + 'px');
      resizeWorkspace();
    });
    splitter.addEventListener('dblclick', () => {
      layout.style.removeProperty('--jr-right-width');
      resizeWorkspace();
    });
    const full = byId('jrFullscreen');
    full.hidden = !document.fullscreenEnabled;
    full.onclick = () => {
      const operation = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      operation.catch(() => {});
    };
    document.addEventListener('fullscreenchange', () => {
      full.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
      resizeWorkspace();
    });
  }

  function closeTools() {
    byId('moreMenu').hidden = true;
    byId('moreBtn').setAttribute('aria-expanded', 'false');
  }

  function updateTerrainBadge() {
    const size = window.DEM_N;
    if (!window.DEM) setText('demBadge', '程序化地形 · 高程数据不可用');
    else if (size === 4096) setText('demBadge', 'SRTM / Terrarium · 4096²');
    else setText('demBadge', 'SRTM / Terrarium · ' + size + '²');
  }

  function mount() {
    document.body.classList.add('dockhide');
    if (narrow.matches) document.body.classList.add('coll-l', 'coll-r');
    narrow.addEventListener('change', ({ matches }) => {
      document.body.classList.toggle('coll-l', matches);
      document.body.classList.toggle('coll-r', matches);
      resizeWorkspace();
    });
    byId('viewPane').append(byId('demBadge'));
    wireMapSize();

    window.__openDrawer = function () {
      document.body.classList.remove('coll-l', 'maxmap');
      byId('btnMax').setAttribute('aria-pressed', 'false');
      if (narrow.matches) document.body.classList.add('coll-r');
      resizeWorkspace();
    };
    window.__closeDrawer = function () {
      document.body.classList.add('coll-l');
      resizeWorkspace();
    };
    window.__toggleDrawer = function () { togglePanel('l'); };
    window.__onStationSelect = value => selectStation(value, true);
    window.__onStationClear = () => selectStation(null, true);

    ['foldL', 'restoreL'].forEach(id => { byId(id).onclick = () => togglePanel('l'); });
    ['foldR', 'restoreR'].forEach(id => { byId(id).onclick = () => togglePanel('r'); });
    byId('sbBack').onclick = () => window.clearStationSelection();
    byId('jrHighRisk').onclick = () => openStations('高风险');
    byId('jrStationScene').onclick = () => { if (station && window.DET.man) window.detEnter(station[0]); };
    byId('jrStationAsk').onclick = () => {
      if (!station) return;
      const name = station[0];
      displayModule('ai');
      byId('aiInput').focus();
      if (window.aiSend) window.aiSend(name + '的风险等级为什么？');
    };
    document.querySelectorAll('[data-jr-module]').forEach(button => {
      button.onclick = () => displayModule(button.dataset.jrModule);
    });
    document.querySelectorAll('[data-jr-dock]').forEach(button => {
      button.onclick = () => {
        if (document.body.classList.contains('jr-model-visible') && button.dataset.jrDock === 'simulation') dock = '';
        document.body.classList.remove('jr-model-visible');
        setDock(button.dataset.jrDock);
      };
    });

    byId('moreBtn').onclick = () => {
      const menu = byId('moreMenu');
      menu.hidden = !menu.hidden;
      byId('moreBtn').setAttribute('aria-expanded', String(!menu.hidden));
    };
    byId('moreMenu').addEventListener('click', closeTools);
    document.addEventListener('click', event => {
      if (!event.target.closest('#moreMenu,#moreBtn')) closeTools();
      if (!event.target.closest('#jrSystem')) byId('jrSystem').open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeTools();
        byId('jrSystem').open = false;
      }
    });
    window.addEventListener('jinsha:stations-ready', () => {
      renderRisks();
      if (station && window.G.selStation) selectStation(window.G.selStation, false);
    });
    window.addEventListener('jinsha:timeline', event => {
      const history = Boolean(event.detail && event.detail.mapColored);
      byId('jrLegendRisk').hidden = history;
      byId('jrLegendHistory').hidden = !history;
    });
    window.addEventListener('jinsha:map-ready', updateTerrainBadge);
    if (window.DEM) updateTerrainBadge();
    if (window.JinshaMapTools) window.JinshaMapTools.applyLayerPreferences();
    new ResizeObserver(resizeWorkspace).observe(byId('rightCol'));
    if (window.JinshaWorkspaceAnalysis) window.JinshaWorkspaceAnalysis.mount();
    renderRisks();
    loadSummary();
    loadClimateKpi();

    setInterval(() => query('/api/data/version').then(data => {
      if (data.token && data.token !== latestToken) loadSummary();
    }).catch(() => {}), 30000);
  }

  window.JinshaWorkspace = {
    moduleChanged(id) {
      if (id === 'map' && narrow.matches) document.body.classList.add('coll-l');
      resizeWorkspace();
    },
    showScenario() {
      document.body.classList.remove('jr-model-visible');
      if (dock !== 'simulation') setDock('simulation');
    },
    showModelRun() {
      document.body.classList.add('jr-model-visible');
      if (dock !== 'simulation') setDock('simulation');
    }
  };
  mount();
})();
