(function () {
  'use strict';

  const labels = { idle: '未运行', ready: '可配置', running: '运行中', done: '已完成', failed: '失败' };
  const metrics = [['eei', 'EEI', '分', 1], ['risk', '综合风险', '分', 1], ['carbon', '碳密度', 't/ha', 1], ['fvc', '植被覆盖', '%', 1]];
  let chosen = null;
  let profileMode = 'long';
  let profileChart = null;
  let scenarioResult = null;
  let station = null;
  let busy = false;

  function element(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }

  function format(key, value, precision) {
    return (value * (key === 'fvc' ? 100 : 1)).toFixed(precision);
  }

  function between(a, b) {
    const lat = (a[1] + b[1]) * Math.PI / 360;
    return Math.hypot((b[0] - a[0]) * 111.32 * Math.cos(lat), (b[1] - a[1]) * 110.57);
  }

  function profileData() {
    const river = window.__MAINSTEM;
    if (!Array.isArray(river) || river.length < 2 || !window.DEM) return null;
    if (profileMode === 'long') {
      const values = [];
      const every = Math.max(1, Math.ceil(river.length / 900));
      let distance = 0;
      for (let i = 0; i < river.length; i++) {
        if (i) distance += between(river[i - 1], river[i]);
        if (i % every === 0 || i === river.length - 1) values.push([+distance.toFixed(2), Math.round(window.demAt(...river[i]))]);
      }
      return { values, source: '沿干流中心线采样 DEM · 横轴为累计距离' };
    }
    const target = station ? [station[2], station[3]] : river[Math.floor(river.length / 2)];
    let index = 0;
    let nearest = Infinity;
    river.forEach((point, i) => {
      const distance = between(point, target);
      if (distance < nearest) { index = i; nearest = distance; }
    });
    const center = river[index], before = river[Math.max(0, index - 3)], after = river[Math.min(river.length - 1, index + 3)];
    const xFactor = Math.cos(center[1] * Math.PI / 180) * 111.32;
    const dx = (after[0] - before[0]) * xFactor, dy = (after[1] - before[1]) * 110.57;
    const norm = Math.hypot(dx, dy) || 1;
    const values = Array.from({ length: 81 }, (_, i) => {
      const distance = (i - 40) / 10;
      const lon = center[0] - dy / norm * distance / xFactor;
      const lat = center[1] + dx / norm * distance / 110.57;
      return [distance, Math.round(window.demAt(lon, lat))];
    });
    return { values, source: (station ? station[0] + '附近干流' : '干流中点') + ' · 垂直于河道 ±4 km · DEM' };
  }

  function renderProfile() {
    const container = document.getElementById('jrProfileChart');
    if (!container || !container.clientWidth || !container.clientHeight) return;
    const source = document.getElementById('jrProfileSource');
    const data = profileData();
    if (!data || !window.echarts) {
      source.textContent = '等待干流与高程数据';
      return;
    }
    source.textContent = data.source;
    if (!profileChart) profileChart = window.echarts.init(container);
    profileChart.setOption({
      animation: false,
      grid: { left: 49, right: 35, top: 14, bottom: 28 },
      tooltip: { trigger: 'axis', confine: true, valueFormatter: v => v + ' m' },
      xAxis: { type: 'value', min: profileMode === 'cross' ? -4 : 0, max: profileMode === 'cross' ? 4 : 'dataMax',
        name: 'km', nameGap: 6, axisLabel: { color: '#9ebbd3', fontSize: 9 }, nameTextStyle: { color: '#a9c6da' } },
      yAxis: { type: 'value', scale: true, min: value => Math.floor(value.min / 100) * 100,
        axisLabel: { formatter: '{value} m', color: '#9ebbd3', fontSize: 9 }, splitLine: { lineStyle: { color: '#283e55' } } },
      series: [{ name: '海拔', type: 'line', showSymbol: false, data: data.values,
        lineStyle: { color: '#75daef', width: 1.7 }, areaStyle: { color: 'rgba(82,208,227,.25)' } }]
    });
    profileChart.resize();
  }

  function chooseScenario(id) {
    chosen = id;
    const buttons = document.querySelectorAll('#jrScenarioOptions button');
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.value === chosen)));
    const result = scenarioResult && scenarioResult.scenarios.find(row => row.id === chosen);
    const baseline = scenarioResult && scenarioResult.scenarios.find(row => row.id === 'baseline');
    const outputs = document.getElementById('jrScenarioOutput');
    if (!result || !baseline) return;
    const heading = element('p', 'jr-scenario-assumption', result.assumption + ' · ' + result.n + ' 站');
    const stats = element('dl', 'jr-scenario-metrics');
    metrics.forEach(([key, name, unit, digits]) => {
      const stat = element('div');
      const delta = result.summary[key] - baseline.summary[key];
      stat.append(element('dt', '', name),
        element('dd', '', format(key, result.summary[key], digits) + ' ' + unit),
        element('small', '', chosen === 'baseline' ? '站点平均' : '较基准 ' + (delta > 0 ? '+' : '') + format(key, delta, digits)));
      stats.append(stat);
    });
    outputs.replaceChildren(heading, stats, element('p', 'jr-scenario-assumption', scenarioResult.note));
  }

  function state(phase, message) {
    const label = document.getElementById('jrScenarioStatus');
    label.textContent = labels[phase] + (message ? ' · ' + message : '');
    label.dataset.phase = phase;
  }

  async function run() {
    if (busy) return;
    busy = true;
    const button = document.getElementById('jrScenarioRun');
    button.disabled = true;
    state('running', '正在重算各站生态指标');
    try {
      const data = await window.dhFetch('/api/scenario/evaluate', 15000);
      if (!data.ok || !data.scenarios || !data.scenarios.length) throw new Error('暂无参与计算的站点');
      scenarioResult = data;
      chooseScenario(chosen || 'baseline');
      document.getElementById('jrScenarioSave').disabled = false;
      state('done', '情景对比已更新');
    } catch (error) {
      state('failed', '请检查本地数据服务后重试');
    } finally {
      button.disabled = false;
      busy = false;
    }
  }

  function mount() {
    const root = document.getElementById('jrScenario');
    const select = document.getElementById('jrScenarioOptions');
    for (const [id, name] of [['baseline', '基准'], ['degraded', '退化管理'], ['restored', '生态修复']]) {
      const option = element('button', 'jr-dock-button', name);
      option.type = 'button';
      option.value = id;
      option.setAttribute('aria-pressed', String(id === 'baseline'));
      option.onclick = () => {
        chooseScenario(id);
        if (!scenarioResult) state('ready', '已选' + name);
      };
      select.append(option);
    }
    document.getElementById('jrScenarioRun').onclick = run;
    const save = document.getElementById('jrScenarioSave');
    save.onclick = async () => {
      if (!scenarioResult) return;
      save.disabled = true;
      try {
        const result = await window.postJSON(window.dhBaseUrl() + '/api/scenario', {
          name: '土地覆盖情景 ' + new Date().toLocaleString('zh-CN'), data: scenarioResult
        }, 1);
        if (!result.ok) throw new Error('保存失败');
        state('done', '已写入情景台账');
      } catch (error) {
        state('failed', '无法保存情景，可重试');
      } finally {
        save.disabled = false;
      }
    };
    document.querySelectorAll('[data-jr-profile]').forEach(button => {
      button.onclick = () => {
        profileMode = button.dataset.jrProfile;
        document.querySelectorAll('[data-jr-profile]').forEach(other => {
          other.setAttribute('aria-pressed', String(profileMode === other.dataset.jrProfile));
        });
        renderProfile();
      };
    });
    const profile = document.getElementById('jrProfileChart');
    new ResizeObserver(renderProfile).observe(profile);
    document.addEventListener('jinsha:station', event => {
      station = event.detail || null;
      if (profileMode === 'cross') renderProfile();
    });
    window.addEventListener('jinsha:map-ready', renderProfile);
    window.addEventListener('jinsha:river-ready', renderProfile);
    new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !scenarioResult && !busy) state('ready', '选择情景后运行');
    }).observe(root);
  }

  mount();
})();
