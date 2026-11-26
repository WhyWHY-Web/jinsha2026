/* Layer and station controls for the existing digital-twin scene. */
(function () {
  'use strict';

  const riskClasses = { '高风险': 'high', '中风险': 'middle', '低风险': 'low' };
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const layers = [
    { id: 'water', name: '干流水体', detail: '发光水面与顺流粒子', groups: ['riverNetGroup', 'waterMesh', 'flowPts'], fullScene: true },
    { id: 'trib', name: '河网线', detail: '干流轴线与主要支流', groups: ['tribGroup', 'mainLineGroup'], fullScene: true },
    { id: 'stations', name: '监测站点', detail: '站点光柱与名称标记', groups: ['stationGroup'] },
    { id: 'ndviTrend', name: 'NDVI 趋势箭头', detail: '显示多年变化方向。年度颜色由时间轴控制。' },
    { id: 'hillshade', name: '山体阴影', detail: '突出河谷与坡面起伏', uniform: 'uShowHill' },
    { id: 'ramp', name: '高程设色', detail: '分色查看地形高度', uniform: 'uShowRamp' },
    { id: 'contour', name: '等高线', detail: '按渲染台的间距绘制', uniform: 'uShowContour' }
  ];
  const stationsLayer = layers.find(layer => layer.id === 'stations');
  const byId = id => document.getElementById(id);
  const stationRows = () => window.STATIONS || [];
  let controls;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  }

  function button(className, value, onClick) {
    const node = element('button', className, value);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function sceneReady() {
    return Boolean(window.G && window.G.layers && window.terrainU);
  }

  function setLayer(layer, visible) {
    const state = window.G.layers;
    state[layer.id] = visible;
    const uniform = window.terrainU[layer.uniform];
    if (uniform) uniform.value = Number(visible);
    const fullScene = !(window.DET && window.DET.cur);
    (layer.groups || []).forEach(group => {
      if (window[group]) window[group].visible = visible && (!layer.fullScene || fullScene);
    });
    if (layer.id === 'water') {
      if (window.riverU) window.riverU.uOn.value = Number(visible);
      if (window.waterU) window.waterU.uOn.value = Number(visible && fullScene);
      if (byId('btnWater')) byId('btnWater').classList.toggle('on', visible);
    }
    if (layer.id === 'ndviTrend') window.JinshaTrendArrows.setVisible(visible);

    applyLayerPreferences();
    document.querySelectorAll('[data-layer], [data-ly]').forEach(node => {
      if ((node.dataset.layer || node.dataset.ly) !== layer.id) return;
      if (node.matches('input[type="checkbox"]')) node.checked = visible;
      else node.classList.toggle('on', visible);
    });
    const layerCount = byId('cvLayers');
    if (layerCount) layerCount.textContent = Object.values(state).filter(Boolean).length;
    if (typeof window.saveSettings === 'function') window.saveSettings();
    document.dispatchEvent(new CustomEvent('jinsha:layers', { detail: { id: layer.id, visible } }));
    refreshLayers();
  }

  function focusStation(name) {
    const index = stationRows().findIndex(row => row[0] === name);
    if (index === -1 || !window.camCtl || typeof window.flyToStationIdx !== 'function') return false;
    if (window.G.roaming && typeof window.toggleRoam === 'function') window.toggleRoam();
    if (sceneReady() && !window.G.layers.stations) setLayer(stationsLayer, true);
    window.flyToStationIdx(index);
    return true;
  }

  function refreshLayers() {
    if (!controls) return;
    const ready = sceneReady();
    const sat = window.SAT;
    controls.satellite.disabled = !ready || Boolean(sat && sat.loading);
    controls.elevation.disabled = controls.satellite.disabled;
    const isSatellite = ready && Boolean(sat && sat.on);
    controls.satellite.setAttribute('aria-pressed', String(isSatellite));
    controls.elevation.setAttribute('aria-pressed', String(ready && !isSatellite));
    controls.layerInputs.forEach((input, id) => {
      const arrows = id === 'ndviTrend' && window.JinshaTrendArrows;
      input.disabled = !ready || (id === 'ndviTrend' && !arrows);
      input.checked = ready && (arrows ? arrows.isVisible() : Boolean(window.G.layers[id]));
    });
    if (ready) {
      const preferences = layerPreferences();
      controls.layerRows.forEach(row => {
        row.style.order = preferences.order.indexOf(row.dataset.layer);
        row.querySelector('.jr-layer-opacity').value = (preferences.opacity[row.dataset.layer] ?? 1) * 100;
      });
    }
    const message = !ready ? '三维场景正在初始化' : sat && sat.loading ? '正在加载本地卫星影像' : '';
    if (controls.layerStatus.textContent !== message) controls.layerStatus.textContent = message;
  }

  function changeBase(useSatellite) {
    if (!sceneReady() || typeof window.toggleSat !== 'function') return;
    if (Boolean(window.SAT && window.SAT.on) !== useSatellite) window.toggleSat(useSatellite);
    refreshLayers();
  }

  const adjustable = layers.filter(layer => ['water', 'trib', 'stations'].includes(layer.id));

  function layerPreferences() {
    const defaults = adjustable.map(layer => layer.id);
    const preferences = window.G.layerPreferences ||= { order: defaults, opacity: {} };
    preferences.order = [...new Set([...preferences.order.filter(id => defaults.includes(id)), ...defaults])];
    return preferences;
  }

  function applyLayerPreferences() {
    if (!sceneReady()) return;
    const { order, opacity } = layerPreferences();
    order.forEach((id, index) => {
      const layer = adjustable.find(entry => entry.id === id);
      (layer.groups || []).forEach(name => {
        const group = window[name];
        if (!group) return;
        group.traverse(object => {
          const material = object.material;
          if (!material || material.opacity === 0 && !material.userData.jrBaseOpacity) return;
          object.userData.jrRenderOrder ??= object.renderOrder;
          object.renderOrder = object.userData.jrRenderOrder + index * 24;
          const value = opacity[id] ?? 1;
          if (material.uniforms && material.uniforms.uLayerOpacity) material.uniforms.uLayerOpacity.value = value;
          else {
            material.userData.jrBaseOpacity ??= material.opacity;
            material.opacity = material.userData.jrBaseOpacity * value;
            object.userData.jrOpacity = value;
          }
        });
      });
    });
  }

  function moveLayer(layer, offset) {
    if (!sceneReady()) return;
    const { order } = layerPreferences();
    const index = order.indexOf(layer.id);
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    controls.layerRows.forEach(row => row.style.order = order.indexOf(row.dataset.layer));
    applyLayerPreferences();
    saveSettings();
  }

  function makeLayerPanel(panel) {
    const basemap = element('div', 'jr-maptools-basemap');
    basemap.append(element('span', 'jr-maptools-label', '底图'));
    const basemapButtons = element('div', 'jr-maptools-options');
    const satellite = button('jr-maptools-option', '卫星影像', () => changeBase(true));
    const elevation = button('jr-maptools-option', '地形底色', () => changeBase(false));
    basemapButtons.append(satellite, elevation);
    basemap.append(basemapButtons);

    const layerStatus = element('div', 'jr-maptools-status');
    layerStatus.setAttribute('aria-live', 'polite');
    basemap.append(layerStatus);
    const stack = element('div', 'jr-layer-stack');
    const terrain = element('div', 'jr-layer-stack');
    panel.append(basemap, element('span', 'jr-maptools-label', '地图叠加图层'), stack,
      element('span', 'jr-maptools-label', '地形与专题'), terrain);

    const layerInputs = new Map();
    const layerRows = [];
    layers.forEach(layer => {
      const row = element('div', 'jr-layer-item');
      const toggle = element('label', 'jr-layer-row');
      const labels = element('span', 'jr-layer-copy');
      labels.append(element('strong', '', layer.name), element('small', '', layer.detail));
      const input = element('input', 'jr-layer-input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        if (sceneReady() && !input.disabled) setLayer(layer, input.checked);
      });
      layerInputs.set(layer.id, input);
      toggle.append(labels, input);
      row.append(toggle);
      if (!adjustable.includes(layer)) {
        terrain.append(row);
        return;
      }
      row.dataset.layer = layer.id;
      const actions = element('div', 'jr-layer-actions');
      const opacity = element('input', 'jr-layer-opacity');
      opacity.type = 'range';
      opacity.min = 0;
      opacity.max = 100;
      opacity.value = 100;
      opacity.dataset.opacityFor = layer.id;
      opacity.setAttribute('aria-label', layer.name + '不透明度');
      opacity.addEventListener('input', () => {
        if (!sceneReady()) return;
        layerPreferences().opacity[layer.id] = Number(opacity.value) / 100;
        applyLayerPreferences();
      });
      opacity.addEventListener('change', () => { if (sceneReady()) saveSettings(); });
      const lower = button('jr-maptools-option', '↓', () => moveLayer(layer, -1));
      const higher = button('jr-maptools-option', '↑', () => moveLayer(layer, 1));
      lower.title = '降低叠加顺序';
      higher.title = '提高叠加顺序';
      lower.setAttribute('aria-label', '降低' + layer.name + '叠加顺序');
      higher.setAttribute('aria-label', '提高' + layer.name + '叠加顺序');
      actions.append(element('span', '', '不透明度'), opacity, lower, higher);
      row.append(actions);
      stack.append(row);
      layerRows.push(row);
    });
    return { satellite, elevation, layerInputs, layerStatus, layerRows };
  }

  function matchStations(query, risk) {
    const q = query.trim().toLowerCase();
    return stationRows().filter(row => {
      if (risk && row[6] !== risk) return false;
      return !q || [row[0], row[1], row[5], row[6], row[10]].some(value =>
        String(value || '').toLowerCase().includes(q));
    });
  }

  function syncSelection() {
    const selection = window.G && window.G.selStation && window.G.selStation[0];
    controls.results.querySelectorAll('.jr-station-row').forEach(row => {
      if (row.dataset.station === selection) row.setAttribute('aria-current', 'location');
      else row.removeAttribute('aria-current');
    });
  }

  function renderStations() {
    if (!controls) return;
    const { results, searchInput, filterButtons, stationStatus } = controls;
    filterButtons.forEach((filter, risk) =>
      filter.setAttribute('aria-pressed', String(risk === controls.risk)));
    const matched = matchStations(searchInput.value, controls.risk);
    const focusedName = document.activeElement && document.activeElement.dataset.station;
    results.replaceChildren();
    let focusedButton;

    matched.forEach(row => {
      const hit = button('jr-station-row', '', () => {
        if (focusStation(row[0])) close(true);
        else stationStatus.textContent = '三维场景尚未就绪，稍后可重新定位';
      });
      hit.dataset.station = row[0];
      const description = element('span', 'jr-station-copy');
      description.append(element('strong', '', row[0]));
      const elevation = row[4] != null && Number.isFinite(Number(row[4]))
        ? numberFormat.format(row[4]) + ' m'
        : '';
      description.append(element('small', '', [row[5], elevation].filter(Boolean).join(' · ')));
      const grade = element('span', 'jr-station-grade', row[6] || '待评估');
      grade.dataset.level = riskClasses[row[6]] || 'unset';
      hit.append(description, grade);
      results.append(hit);
      if (row[0] === focusedName) focusedButton = hit;
    });

    stationStatus.textContent = stationRows().length
      ? '找到 ' + matched.length + ' 个站点'
      : '站点数据暂不可用';
    if (!matched.length && stationRows().length) {
      results.append(element('p', 'jr-maptools-empty', '没有匹配的站点。试试站名、分区或其他风险等级。'));
    }
    controls.stationSource = window.STATIONS;
    syncSelection();
    if (focusedButton) focusedButton.focus({ preventScroll: true });
  }

  function makeStationPanel(panel) {
    const label = element('label', 'jr-maptools-label', '搜索站点');
    const searchInput = element('input', 'jr-maptools-search');
    searchInput.type = 'search';
    searchInput.id = panel.id + '-search';
    searchInput.placeholder = '输入站名、类型或分区';
    searchInput.autocomplete = 'off';
    label.htmlFor = searchInput.id;
    searchInput.addEventListener('input', renderStations);

    const filters = element('div', 'jr-maptools-options jr-maptools-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '按风险等级筛选');
    const filterButtons = new Map();
    ['', '高风险', '中风险', '低风险'].forEach(risk => {
      const filter = button('jr-maptools-option', risk || '全部', () => filterRisk(risk));
      filterButtons.set(risk, filter);
      filters.append(filter);
    });

    const stationStatus = element('div', 'jr-maptools-status');
    stationStatus.setAttribute('aria-live', 'polite');
    const results = element('div', 'jr-station-results');
    searchInput.addEventListener('keydown', event => {
      if (event.isComposing || !['Enter', 'ArrowDown'].includes(event.key)) return;
      const first = results.querySelector('button');
      if (!first) return;
      event.preventDefault();
      if (event.key === 'Enter') first.click();
      else first.focus();
    });

    panel.append(label, searchInput, filters, stationStatus, results);
    return { searchInput, filterButtons, stationStatus, results };
  }

  function setTab(tab) {
    controls.currentTab = tab;
    controls.tabs.forEach((control, name) => {
      control.tab.setAttribute('aria-selected', String(name === tab));
      control.tab.tabIndex = name === tab ? 0 : -1;
      control.panel.hidden = name !== tab;
    });
    refresh();
  }

  function normalizeRisk(risk) {
    return Object.prototype.hasOwnProperty.call(riskClasses, risk) ? risk : '';
  }

  function filterRisk(risk) {
    if (!controls) return;
    controls.risk = normalizeRisk(risk);
    renderStations();
  }

  function open(tab, risk) {
    if (!controls && !mount()) return false;
    if (risk !== undefined) {
      controls.risk = normalizeRisk(risk);
      controls.searchInput.value = '';
    }
    controls.container.hidden = false;
    if (controls.trigger) controls.trigger.setAttribute('aria-expanded', 'true');
    setTab(controls.tabs.has(tab) ? tab : controls.currentTab);
    if (controls.currentTab === 'stations') controls.searchInput.focus();
    else controls.tabs.get(controls.currentTab).tab.focus();
    clearInterval(controls.syncTimer);
    controls.syncTimer = setInterval(() => {
      if (controls.stationSource !== window.STATIONS) renderStations();
      else syncSelection();
      refreshLayers();
    }, 700);
    return true;
  }

  function close(returnFocus) {
    if (!controls) return;
    clearInterval(controls.syncTimer);
    controls.container.hidden = true;
    if (!controls.trigger) return;
    controls.trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) controls.trigger.focus();
  }

  function refresh() {
    if (!controls) return;
    refreshLayers();
    renderStations();
  }

  function mount(options = {}) {
    if (controls) return true;
    const container = byId(options.containerId || 'jrMapTools');
    const trigger = byId(options.buttonId || 'jrMapToolsButton');
    if (!container) return false;

    const title = element('h2', '', '图层与站点');
    title.id = container.id + '-title';
    container.setAttribute('aria-labelledby', title.id);
    container.classList.add('jr-maptools');
    container.hidden = true;
    const header = element('header', 'jr-maptools-head');
    const closeButton = button('jr-maptools-close', '×', () => close(true));
    closeButton.setAttribute('aria-label', '收起图层与站点面板');
    header.append(title, closeButton);

    const tabList = element('div', 'jr-maptools-tabs');
    const tabs = new Map();
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', '地图工具');
    const sections = [['layers', '图层'], ['stations', '站点']].map(([name, label]) => {
      const tab = button('jr-maptools-tab', label, () => setTab(name));
      const panel = element('div', 'jr-maptools-panel');
      tab.id = container.id + '-tab-' + name;
      panel.id = container.id + '-panel-' + name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      tabs.set(name, { tab, panel });
      tabList.append(tab);
      return panel;
    });

    controls = {
      container, trigger, tabs, currentTab: 'layers', risk: '',
      ...makeLayerPanel(sections[0]),
      ...makeStationPanel(sections[1])
    };
    container.replaceChildren(header, tabList, ...sections);
    setTab('layers');
    close();

    tabList.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tab = event.key === 'Home' ? 'layers'
        : event.key === 'End' ? 'stations'
          : controls.currentTab === 'layers' ? 'stations' : 'layers';
      setTab(tab);
      tabs.get(tab).tab.focus();
    });

    container.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    });
    if (trigger) trigger.addEventListener('click', () => {
      if (container.hidden) open();
      else close();
    });

    return true;
  }

  const css = element('style');
  css.textContent = `
.jr-maptools[hidden], .jr-maptools [hidden] { display: none !important; }
.jr-maptools {
  --jr-tools-accent: #79d7ff;
  --jr-tools-stroke: rgba(142, 191, 224, .23);
  box-sizing: border-box;
  width: min(330px, calc(100vw - 32px));
  max-width: 100%;
  color: #e9f5ff;
  background: rgba(10, 25, 42, .98);
  border: 1px solid var(--jr-tools-stroke);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .42);
  overflow: hidden;
}
.jr-maptools-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px 4px; }
.jr-maptools-head h2 { margin: 0; font-size: 16px; letter-spacing: .025em; }
.jr-maptools button { color: inherit; font: inherit; cursor: pointer; }
.jr-maptools .jr-maptools-close { padding: 0; width: 28px; height: 28px; background: transparent; border: 0; border-radius: 4px; font-size: 20px; }
.jr-maptools-close:hover { background: rgba(158, 205, 236, .14); }
.jr-maptools-tabs { display: flex; gap: 18px; padding: 0 14px; border-bottom: 1px solid var(--jr-tools-stroke); }
.jr-maptools .jr-maptools-tab {
  padding: 7px 3px 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #a1b9cc;
  font-size: 13px;
}
.jr-maptools-tab[aria-selected="true"] { color: #e9f5ff; border-color: var(--jr-tools-accent); }
.jr-maptools-panel { padding: 12px 14px; max-height: min(52vh, 410px); overflow: auto; color-scheme: dark; }
.jr-maptools-label { display: block; margin: 0 0 7px; color: #b5cfe1; font-size: 12px; font-weight: 600; }
.jr-maptools-basemap { margin-bottom: 12px; }
.jr-maptools-options { display: flex; gap: 5px; flex-wrap: wrap; }
.jr-maptools .jr-maptools-option {
  padding: 5px 8px;
  background: #10263c;
  color: #b6cde0;
  font-size: 12px;
  border: 1px solid var(--jr-tools-stroke);
  border-radius: 5px;
}
.jr-maptools .jr-maptools-option:hover:not(:disabled), .jr-maptools .jr-maptools-option[aria-pressed="true"] {
  border-color: var(--jr-tools-accent);
  color: #e1f4ff;
  background: #173c56;
}
.jr-maptools .jr-maptools-option:disabled { opacity: .55; cursor: default; }
.jr-maptools-status { margin: 7px 0; color: #9ab6cb; font-size: 11px; }
.jr-maptools-status:empty { display: none; }
.jr-layer-row, .jr-maptools .jr-station-row {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  padding: 7px 0;
  border: 0;
  border-bottom: 1px solid rgba(142, 191, 224, .12);
  background: transparent;
  text-align: left;
}
.jr-layer-row { cursor: pointer; }
.jr-layer-copy, .jr-station-copy { display: grid; gap: 2px; }
.jr-maptools .jr-layer-copy strong, .jr-maptools .jr-station-copy strong { font-size: 13px; font-weight: 600; }
.jr-maptools small { color: #9ab6cb; font-size: 11px; }
.jr-layer-input { margin: 0 2px 0 0; width: 15px; height: 15px; accent-color: var(--jr-tools-accent); cursor: pointer; }
.jr-maptools-search {
  width: 100%; box-sizing: border-box; border: 1px solid var(--jr-tools-stroke); border-radius: 5px;
  background: #0a1b2d; color: #e9f5ff; padding: 7px 8px; font: inherit; font-size: 13px;
}
.jr-maptools-search::placeholder { color: #92aec3; }
.jr-maptools-filters { margin-top: 9px; }
.jr-maptools .jr-station-row { padding-inline: 6px; border-radius: 4px; }
.jr-maptools .jr-station-row:hover, .jr-maptools .jr-station-row[aria-current] { background: #17364e; }
.jr-station-grade { color: #b6cde0; white-space: nowrap; font-size: 11px; }
.jr-station-grade[data-level="high"] { color: #ff9d9d; }
.jr-station-grade[data-level="middle"] { color: #ffcd84; }
.jr-station-grade[data-level="low"] { color: #75d8b3; }
.jr-maptools-empty { color: #acbfd0; margin: 9px 0; font-size: 12px; line-height: 1.5; }
.jr-maptools :focus-visible { outline: 2px solid var(--jr-tools-accent); outline-offset: 2px; }
`;
  document.head.append(css);

  window.addEventListener('jinsha:map-ready', applyLayerPreferences);
  window.addEventListener('jinsha:river-ready', applyLayerPreferences);
  window.addEventListener('jinsha:stations-ready', applyLayerPreferences);
  window.JinshaMapTools = { applyLayerPreferences, mount, open, close, filterRisk, focusStation, refresh };
  window.addEventListener('jinsha:stations-ready', () => {
    if (controls && !controls.container.hidden) renderStations();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
  else mount();
})();
