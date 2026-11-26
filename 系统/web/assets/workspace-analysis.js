/* The map and the trend panel share the same observed year. */
(function () {
  'use strict';

  const metrics = {
    ndvi: { label: 'NDVI', unit: '无量纲', digits: 3, color: '#54e5b5', source: 'MODIS MOD13Q1' },
    temperature: { label: '年均温', unit: '℃', digits: 2, color: '#ffb297', field: '年均温_℃', source: 'NASA POWER · MERRA-2' },
    precipitation: { label: '年降水', unit: 'mm', digits: 0, color: '#6fc9ff', field: '年降水_mm', source: 'NASA POWER · MERRA-2' },
    evaporation: { label: '年蒸散', unit: 'mm', digits: 0, color: '#adbcff', field: '年蒸散_mm', source: 'NASA POWER · MERRA-2' }
  };
  const ndviColors = [0xe0a04e, 0xaed77a, 0x49e4ad, 0x11a777];
  const missingColor = 0x6c8294;
  const state = {
    ndvi: new Map(),
    mean: new Map(),
    climate: new Map(),
    years: [],
    year: null,
    range: null,
    station: null,
    metric: 'ndvi',
    mapColored: false,
    timer: null,
    loading: false,
    errors: {},
    chart: null,
    chartKey: '',
    elements: null
  };

  function mount() {
    const timeline = document.getElementById('jrTimeline');
    if (!timeline || state.elements) return;
    const trend = document.getElementById('jrTrendPanel') || timeline;
    timeline.innerHTML = [
      '<div class="jr-timeline-rail">',
      '<button type="button" class="jr-year-play" data-jr-year-play aria-label="播放时间轴" title="播放时间轴">▶</button>',
      '<div class="jr-year-current"><label for="jrTimelineYear">观测年份</label><output for="jrTimelineYear">—</output></div>',
      '<div class="jr-year-slider"><input id="jrTimelineYear" type="range" min="0" max="0" value="0" aria-label="观测年份" disabled>',
      '<div class="jr-year-ticks" aria-hidden="true"></div></div>',
      '<button type="button" class="jr-year-mode" aria-pressed="false" title="在站点风险和年度 NDVI 之间切换" disabled>风险着色</button>',
      '<div class="jr-year-legend" hidden aria-label="NDVI 色标"><div><span></span><i></i><span></span></div><small>灰色 · 缺测</small></div>',
      '</div>'
    ].join('');
    trend.insertAdjacentHTML('beforeend', [
      '<div class="jr-timeline-trend">',
      '<div class="jr-timeline-head"><h3 class="jr-timeline-title">年度趋势</h3>',
      '<select class="jr-timeline-metric" aria-label="趋势指标">',
      '<option value="ndvi">NDVI</option><option value="temperature">年均温</option>',
      '<option value="precipitation">年降水</option><option value="evaporation">年蒸散</option>',
      '</select></div>',
      '<div class="jr-timeline-meta"></div>',
      '<div class="jr-timeline-chart" role="img" aria-label="年度趋势图"></div>',
      '<div class="jr-timeline-readings">',
      '<div class="jr-timeline-stat"><span>NDVI</span><b>—</b></div>',
      '<div class="jr-timeline-stat"><span>流域年均温</span><b>—</b></div>',
      '<div class="jr-timeline-stat"><span>流域年降水</span><b>—</b></div>',
      '</div>',
      '<div class="jr-timeline-status" aria-live="polite">',
      '<span></span><button type="button" hidden>重试</button></div>',
      '</div>'
    ].join(''));

    addStyles();
    const elements = state.elements = {
      timeline,
      play: timeline.querySelector('[data-jr-year-play]'),
      year: timeline.querySelector('output'),
      slider: timeline.querySelector('input'),
      ticks: timeline.querySelector('.jr-year-ticks'),
      mode: timeline.querySelector('.jr-year-mode'),
      legend: timeline.querySelector('.jr-year-legend'),
      legendRange: timeline.querySelectorAll('.jr-year-legend span'),
      metric: trend.querySelector('.jr-timeline-metric'),
      meta: trend.querySelector('.jr-timeline-meta'),
      chart: trend.querySelector('.jr-timeline-chart'),
      readings: trend.querySelectorAll('.jr-timeline-stat b'),
      status: trend.querySelector('.jr-timeline-status span'),
      retry: trend.querySelector('.jr-timeline-status button')
    };
    elements.play.addEventListener('click', togglePlay);
    elements.slider.addEventListener('input', function () {
      setYear(state.years[Number(this.value)]);
    });
    elements.mode.addEventListener('click', function () { toggleMapColor(); });
    elements.metric.addEventListener('change', function () {
      stopPlay();
      state.metric = this.value;
      render();
    });
    elements.retry.addEventListener('click', loadData);
    window.addEventListener('jinsha:station', event => selectStation(event.detail));
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (state.chart && elements.chart.clientWidth) state.chart.resize();
        drawChart();
      });
      observer.observe(elements.chart);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPlay();
    });
    loadData();
  }

  function number(value) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
    return Number(value);
  }

  function getYear(value) {
    const year = number(value);
    return Number.isInteger(year) && year > 0 ? year : null;
  }

  function indexNdvi(payload) {
    if (!payload || payload.ok !== true || !payload.stations) throw new Error('NDVI 响应格式无效');
    const stations = new Map();
    const totals = new Map();
    let min = Infinity;
    let max = -Infinity;
    for (const [station, rows] of Object.entries(payload.stations)) {
      if (!Array.isArray(rows)) continue;
      const values = new Map();
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const year = getYear(row[0]);
        const value = number(row[1]);
        if (year === null || value === null) continue;
        values.set(year, value);
      }
      if (!values.size) continue;
      stations.set(station, values);
      for (const [year, value] of values) {
        min = Math.min(min, value);
        max = Math.max(max, value);
        const total = totals.get(year) || { sum: 0, count: 0 };
        total.sum += value;
        total.count += 1;
        totals.set(year, total);
      }
    }
    state.ndvi = stations;
    state.mean = new Map(Array.from(totals, ([year, total]) => [year, total.sum / total.count]));
    state.range = stations.size ? [min, max] : null;
  }

  function indexClimate(payload) {
    if (!Array.isArray(payload)) throw new Error('气候响应格式无效');
    state.climate = new Map(payload.flatMap(row => {
      const year = getYear(row?.year);
      return year == null ? [] : [[year, row]];
    }));
  }

  async function readJson(path) {
    if (typeof window.dhFetch === 'function') return window.dhFetch(path, 10000);
    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async function loadData() {
    if (state.loading) return;
    const wasMapColored = state.mapColored;
    state.loading = true;
    state.errors = {};
    render();
    const jobs = [
      ['ndvi', '/api/ndvi/annual', indexNdvi],
      ['climate', '/api/data/basin_annual', indexClimate]
    ];
    await Promise.all(jobs.map(async ([key, url, index]) => {
      try {
        index(await readJson(url));
      } catch (error) {
        state.errors[key] = error;
      }
    }));
    state.years = Array.from(new Set([...state.mean.keys(), ...state.climate.keys()])).sort((a, b) => a - b);
    if (!state.years.includes(state.year)) state.year = state.years.at(-1) ?? null;
    if (!state.range) state.mapColored = false;
    state.loading = false;
    state.chartKey = '';
    render();
    if (wasMapColored || state.mapColored) refreshMap();
    publish();
  }

  function selectStation(selection) {
    const station = Array.isArray(selection) ? selection[0] :
      typeof selection === 'object' && selection ? selection.name : selection;
    if ((station || null) === state.station) return;
    state.station = station || null;
    render();
    publish();
  }

  function valuesForYear(year) {
    const ndvi = state.station ? state.ndvi.get(state.station) : state.mean;
    const climate = state.climate.get(year) || {};
    return {
      ndvi: ndvi?.get(year) ?? null,
      temperature: number(climate[metrics.temperature.field]),
      precipitation: number(climate[metrics.precipitation.field]),
      evaporation: number(climate[metrics.evaporation.field])
    };
  }

  function showYear(year) {
    state.year = year;
    if (state.range) state.mapColored = true;
    render();
    if (state.mapColored) refreshMap();
    publish();
  }

  function setYear(value) {
    const year = getYear(value);
    if (!state.years.includes(year)) return false;
    stopPlay();
    showYear(year);
    return true;
  }

  function stopPlay() {
    if (state.timer === null) return;
    clearInterval(state.timer);
    state.timer = null;
    updateTransport();
  }

  function togglePlay() {
    if (state.timer !== null) {
      stopPlay();
      return;
    }
    const playable = state.years.filter(year => valuesForYear(year)[state.metric] !== null);
    const years = playable.length > 1 ? playable : state.years;
    if (years.length < 2) return;
    function step() {
      const following = years.find(year => year > state.year);
      showYear(following ?? years[0]);
    }
    state.timer = setInterval(step, 1000);
    step();
  }

  function toggleMapColor() {
    if (!state.range) return false;
    state.mapColored = !state.mapColored;
    if (!state.mapColored) stopPlay();
    render();
    refreshMap();
    publish();
    return state.mapColored;
  }

  function ndviColor(value) {
    if (value == null) return missingColor;
    const [min, max] = state.range;
    const position = max === min ? 1.5 : (value - min) / (max - min) * 3;
    const index = Math.min(2, Math.max(0, Math.floor(position)));
    const fraction = position - index;
    const from = ndviColors[index];
    const to = ndviColors[index + 1];
    const channel = shift => Math.round(((from >> shift) & 255) * (1 - fraction) + ((to >> shift) & 255) * fraction);
    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
  }

  function riskColor(risk) {
    if (typeof window.riskColOf === 'function') {
      const parsed = parseInt(String(window.riskColOf(risk)).replace('#', ''), 16);
      if (Number.isInteger(parsed)) return parsed;
    }
    return risk === '高风险' ? 0xff5a5a : risk === '中风险' ? 0xffb03a : 0x4ade80;
  }

  function refreshMap() {
    if (!state.elements) return;
    const stations = new Map((window.STATIONS || []).map(row => [row[0], row]));
    for (const pillar of window.pillars || []) {
      const station = pillar.userData?.st;
      if (!station || !pillar.material?.color) continue;
      const color = state.mapColored && state.range ?
        ndviColor(state.ndvi.get(station[0])?.get(state.year)) :
        riskColor((stations.get(station[0]) || station)[6]);
      pillar.material.color.setHex(color);
    }
  }

  function publish() {
    window.dispatchEvent(new CustomEvent('jinsha:timeline', {
      detail: {
        year: state.year,
        station: state.station,
        mapColored: state.mapColored,
        ndviRange: state.range?.slice() ?? null,
        values: valuesForYear(state.year)
      }
    }));
  }

  function formatted(value, metric, withUnit) {
    if (value == null) return '—';
    const unit = withUnit && metric.unit !== '无量纲' ? ' ' + metric.unit : '';
    return value.toFixed(metric.digits) + unit;
  }

  function updateTransport() {
    const el = state.elements;
    if (!el) return;
    const years = state.years;
    const playing = state.timer !== null;
    el.play.textContent = playing ? 'Ⅱ' : '▶';
    el.play.title = playing ? '暂停时间轴' : '播放时间轴';
    el.play.setAttribute('aria-label', el.play.title);
    el.play.disabled = years.length < 2;
    el.year.textContent = state.year ?? '—';
    el.slider.disabled = years.length < 2;
    el.slider.max = String(Math.max(0, years.length - 1));
    el.slider.value = String(Math.max(0, years.indexOf(state.year)));
    el.slider.setAttribute('aria-valuetext', state.year == null ? '无可用年份' : state.year + ' 年');
    const yearTicks = years.length < 3 ? years : [years[0], years[Math.floor(years.length / 2)], years.at(-1)];
    el.ticks.innerHTML = yearTicks.map(year => '<span>' + year + '</span>').join('');
    el.mode.disabled = !state.range;
    el.mode.textContent = state.mapColored ? 'NDVI 着色' : '风险着色';
    el.mode.setAttribute('aria-pressed', String(state.mapColored));
    el.legend.hidden = !state.mapColored || !state.range;
    if (state.range) {
      el.legendRange[0].textContent = state.range[0].toFixed(2);
      el.legendRange[1].textContent = state.range[1].toFixed(2);
    }
  }

  function render() {
    const el = state.elements;
    if (!el) return;
    updateTransport();
    const values = valuesForYear(state.year);
    const metric = metrics[state.metric];
    const scope = state.metric === 'ndvi' ? state.station || '站点等权平均' : '流域面平均';
    ['ndvi', 'temperature', 'precipitation'].forEach((key, index) => {
      el.readings[index].textContent = formatted(values[key], metrics[key], true);
      el.readings[index].title = values[key] === null ? '该年份无有效数据' : state.year + ' 年 · ' + metrics[key].source;
    });
    const years = state.years.filter(year => valuesForYear(year)[state.metric] !== null);
    const period = years.length ? ' · ' + years[0] + '–' + years.at(-1) : '';
    el.meta.textContent = scope + ' · ' + metric.unit + period;
    el.meta.title = el.meta.textContent + ' · ' + metric.source;

    const failed = Object.keys(state.errors);
    let status = metric.source;
    if (state.loading) status = '正在读取年度数据…';
    else if (failed.length === 2) status = '年度数据加载失败';
    else if (failed.length) status = failed[0] === 'ndvi' ? 'NDVI 数据加载失败' : '流域气候数据加载失败';
    else if (!years.length) status = '此范围暂无年度序列';
    else if (values[state.metric] === null) status = state.year + ' 年暂无该指标';
    el.status.textContent = status;
    el.retry.hidden = state.loading || !failed.length;
    drawChart();
  }

  function drawChart() {
    const el = state.elements;
    if (!el || !el.chart.clientWidth || !el.chart.clientHeight || state.loading) return;
    const metric = metrics[state.metric];
    const key = [state.metric, state.station, state.year, state.years.length].join('|');
    if (state.chartKey === key) return;
    if (!window.echarts) {
      el.chart.textContent = '图表组件不可用';
      return;
    }
    if (!state.chart) {
      el.chart.textContent = '';
      state.chart = window.echarts.init(el.chart, null, { renderer: 'canvas' });
      state.chart.on('click', params => setYear(params.name));
    }

    const dataYears = state.years.filter(year => valuesForYear(year)[state.metric] !== null);
    const chartYears = dataYears.length ? state.years.filter(year => year >= dataYears[0] && year <= dataYears.at(-1)) : [];
    const values = chartYears.map(year => valuesForYear(year)[state.metric]);
    const showYearLine = chartYears.includes(state.year);
    state.chart.setOption({
      animation: false,
      aria: { enabled: true, description: (state.station && state.metric === 'ndvi' ? state.station : '流域') + ' ' + metric.label + ' 年度趋势' },
      grid: { left: 34, right: 10, top: 10, bottom: 22 },
      graphic: chartYears.length ? [] : [{
        type: 'text', left: 'center', top: 'middle',
        style: { text: '暂无可绘制数据', fill: '#7f9cab', fontSize: 11 }
      }],
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: '#132733', borderColor: '#365665',
        textStyle: { fontSize: 11, color: '#e3f4fa' },
        valueFormatter: value => formatted(number(value), metric, true)
      },
      xAxis: {
        type: 'category', data: chartYears.map(String), boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#3a5667' } },
        axisLabel: { color: '#9aafba', fontSize: 9, hideOverlap: true, showMinLabel: true, showMaxLabel: true, margin: 6 }
      },
      yAxis: {
        type: 'value', scale: true, splitNumber: 3,
        axisLabel: { color: '#9aafba', fontSize: 9, margin: 4 },
        splitLine: { lineStyle: { color: '#233e4d', type: 'dashed' } }
      },
      series: [{
        name: metric.label, type: 'line', data: values, connectNulls: false, showSymbol: true, symbolSize: 4,
        itemStyle: { color: metric.color }, lineStyle: { width: 1.7, color: metric.color },
        areaStyle: { color: metric.color, opacity: 0.09 },
        markLine: {
          silent: true, symbol: ['none', 'none'], label: { show: false },
          lineStyle: { color: '#c4e4f0', type: 'dashed', opacity: 0.65 },
          data: showYearLine ? [{ xAxis: String(state.year) }] : []
        }
      }]
    }, { notMerge: true });
    state.chartKey = key;
  }

  function addStyles() {
    const styles = document.createElement('style');
    styles.textContent = [
      '#jrTimeline,#jrTrendPanel{min-width:0}',
      '.jr-timeline-rail{display:grid;grid-template-columns:32px auto minmax(95px,1fr) auto auto;align-items:center;gap:12px;min-width:0;padding:8px 10px;color:#dceef5}',
      '.jr-timeline-rail button,.jr-timeline-metric,.jr-timeline-status button{font:inherit;color:#bde6eb;background:#102632;border:1px solid #345263;border-radius:6px;cursor:pointer}',
      '.jr-timeline-rail button:focus-visible,.jr-timeline-rail input:focus-visible,.jr-timeline-metric:focus-visible,.jr-timeline-status button:focus-visible{outline:2px solid #59e5ca;outline-offset:3px}',
      '.jr-timeline-rail button:disabled{cursor:default;opacity:.52}',
      '.jr-timeline-rail .jr-year-play{height:32px;width:32px;color:#75edcf;font-size:13px}',
      '.jr-year-current{min-width:48px;display:flex;flex-direction:column;gap:1px}',
      '.jr-year-current label,.jr-year-ticks,.jr-year-legend,.jr-timeline-meta,.jr-timeline-status{color:#9cb5c2;font-size:10px}',
      '.jr-year-current output{font:bold 18px/1.2 Consolas,monospace;color:#e5faf8}',
      '.jr-year-slider{display:grid;align-items:center;min-width:0;padding-top:3px}',
      '.jr-year-slider input{width:100%;margin:0;accent-color:#50dbba;cursor:pointer}',
      '.jr-year-ticks{display:flex;justify-content:space-between;font-family:Consolas,monospace;margin:0 7px}',
      '.jr-timeline-rail .jr-year-mode{padding:7px 8px;white-space:nowrap;font-size:11px}',
      '.jr-year-mode[aria-pressed=true]{color:#9aefd3;border-color:#48967d}',
      '.jr-year-legend{font-family:Consolas,monospace;text-align:center;white-space:nowrap}',
      '.jr-year-legend[hidden],.jr-timeline-status button[hidden]{display:none}',
      '.jr-year-legend div{display:flex;align-items:center;gap:4px}',
      '.jr-year-legend i{width:38px;height:5px;border-radius:8px;background:linear-gradient(90deg,#e0a04e,#aed77a,#49e4ad,#11a777)}',
      '.jr-year-legend small{font:inherit;color:#9cb5c2}',
      '.jr-timeline-trend{min-width:0;color:#e0f3f9}',
      '.jr-timeline-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:3px}',
      '.jr-timeline-head .jr-timeline-title{font-size:13px;font-weight:650;margin:0;line-height:1.3}',
      '.jr-timeline-metric{padding:4px 4px;font-size:10px;max-width:85px}',
      '.jr-timeline-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}',
      '.jr-timeline-chart{height:94px;min-width:0;margin-top:3px;font-size:11px}',
      '.jr-timeline-readings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #294551;gap:4px;padding-top:6px}',
      '.jr-timeline-stat span,.jr-timeline-stat b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.jr-timeline-stat span{color:#9cb5c2;font-size:10px}',
      '.jr-timeline-stat b{color:#dcf5f4;font:600 12px/1.4 Consolas,monospace}',
      '.jr-timeline-status{display:flex;align-items:center;justify-content:space-between;gap:4px;min-height:15px;margin-top:5px}',
      '.jr-timeline-status button{padding:2px 6px;font-size:10px}',
      '@media(max-width:700px){.jr-timeline-rail{gap:6px;padding:6px}.jr-year-legend i{width:20px}.jr-year-ticks span:nth-child(2){display:none}}',
      '@media(max-width:410px){.jr-timeline-rail{grid-template-columns:28px auto minmax(65px,1fr) auto}.jr-timeline-rail .jr-year-play{width:28px}.jr-year-legend{grid-column:3 / -1;justify-self:end}}'
    ].join('\n');
    document.head.appendChild(styles);
  }

  window.JinshaWorkspaceAnalysis = { mount, selectStation, setYear, toggleMapColor, refreshMap };
})();
