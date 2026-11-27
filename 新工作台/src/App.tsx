import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Building2, ChartNoAxesCombined, ChevronRight, Database, Droplet, Droplets, Layers3, Leaf, MapPin, MountainSnow, Pause, Play, Search, ShieldAlert, Waypoints, Waves, X } from 'lucide-react'
import { TerrainMap } from './TerrainMap'
import { ArchivePane } from './ArchivePane'
import { TrendChart } from './TrendChart'
import { useEngineering, OperationsPanel, operationalStations, operationMarks } from './operations'
import { useFloodReplay, FloodLeft, FloodRight, FloodTimeline, floodColors } from './FloodPane'
import { QualityResponse } from './QualityResponse'
import { EcologyPane, ecologyMarks, useEcology } from './EcologyPane'
import type { Dashboard, Dataset, MapLocation, Metric, Point, RseiLayer, Scene, Series, Station, StationMark } from './data'
import './styles.css'

const scenes = [
  { id:'ecology', name:'生态评估', icon:Leaf },
  { id:'water', name:'径流分析', icon:Droplets },
  { id:'engineering', name:'工程管理', icon:Building2 },
  { id:'dispatch', name:'调度档案', icon:Waypoints },
  { id:'flood', name:'洪水回放', icon:Waves },
  { id:'quality', name:'水质', icon:Droplet },
  { id:'emergency', name:'应急', icon:ShieldAlert },
  { id:'data', name:'数据资源', icon:Database }
] as const
const sceneCaptions: Record<Scene,string> = {
  ecology:'生态评估工作台', overview:'生态与水文', vegetation:'植被演变', water:'模型径流', engineering:'梯级工程',
  dispatch:'历史调度', flood:'历史洪峰', quality:'水质资料', emergency:'应急资料', data:'数据资源'
}
const metrics: Record<Metric,{ name:string, unit:string, digits:number, color:string }> = {
  ndvi:{ name:'植被指数 NDVI', unit:'无量纲', digits:3, color:'#5be5c5' },
  temperature:{ name:'年均气温', unit:'°C', digits:2, color:'#95baff' },
  precipitation:{ name:'年降水量', unit:'mm', digits:0, color:'#57ccff' },
  evapotranspiration:{ name:'年蒸散量', unit:'mm', digits:0, color:'#80a9ea' },
  discharge:{ name:'年均径流', unit:'m³/s', digits:1, color:'#58d0ff' }
}
const format = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('zh-CN',{ minimumFractionDigits:digits, maximumFractionDigits:digits }).format(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function useJson<T>(endpoint: string | null) {
  const [result, setResult] = useState<{ endpoint: string, data: T | null, error: boolean } | null>(null)
  useEffect(() => {
    if (!endpoint) return
    const controller = new AbortController()
    fetch(endpoint, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(String(response.status))
      return response.json() as Promise<T>
    }).then(data => setResult({ endpoint, data, error:false })).catch(error => {
      if (error.name !== 'AbortError') setResult({ endpoint, data:null, error:true })
    })
    return () => controller.abort()
  }, [endpoint])
  return result?.endpoint === endpoint ? result : null
}

function coverFor(station: Station | null) {
  const raw = station?.cover?.['林地']
  return !isNumber(raw) ? null : raw <= 1 ? raw * 100 : raw
}

function recordCount(item: Dataset): number | undefined {
  const value = item.rows ?? item.count ?? item.records
  return isNumber(value) ? value : undefined
}

function PanelTitle({ children, tag }: { children: string, tag?: string }) {
  return <header className="panel-title"><h2>{children}</h2>{tag && <span>{tag}</span>}</header>
}

function SourceList({ catalog, onSelect }: { catalog: Dataset[]; onSelect:(item:Dataset)=>void }) {
  return <div className="source-list">{catalog.map((item, index) => {
    const line = <><Database size={14}/>
      <div><strong>{item.label ?? item.name ?? '数据集'}</strong><small>{item.source ?? item.note ?? '本地数据'}</small></div>
      {recordCount(item) !== undefined && <span>{format(recordCount(item))}</span>}</>
    return item.queryable ? <button type="button" key={item.id ?? index}
      onClick={()=>onSelect(item)} aria-label={'浏览 '+(item.label ?? item.name)}>{line}</button> :
      <article key={item.id ?? index}>{line}</article>
  })}</div>
}

function MonthlyBars({ rows }: { rows:Array<{month:number;value:number|null}> }) {
  const max = Math.max(1,...rows.map(point=>point.value ?? 0))
  if (!rows.length) return <p className="empty-list">该年暂无逐月记录</p>
  return <div className="month-bars" aria-label="逐月降水柱状图">
    {rows.map(point=><div key={point.month} title={point.month+' 月 · '+format(point.value,1)+' mm'}>
      <div><i style={{height:Math.max(1,(point.value ?? 0)/max*100)+'%'}}/></div><span>{point.month}</span>
    </div>)}
  </div>
}

function StationInformation({ station, point }: { station: Station, point?: Point }) {
  const eei = station.assessment?.eei
  const grade = station.assessment?.grade
  const rows = [
    ['海拔', format(station.elevation), 'm'],
    ['林地占比', format(coverFor(station),1), '%'],
    ['历史 EEI', isNumber(eei) ? format(eei,1) : '—', typeof grade === 'string' ? grade+'级' : ''],
    ['坐标', format(station.lon,3) + ' E', format(station.lat,3) + ' N']
  ]
  return <div className="station-detail">
    <span className="detail-type">{station.type} · {station.zone}</span>
    <dl>{rows.map(([label,value,unit]) => <div key={label}><dt>{label}</dt><dd>{value} <small>{unit}</small></dd></div>)}</dl>
    <p>{point?.value != null ? point.year+' 年 NDVI '+format(point.value,3)+'。' : '选中年份的 NDVI 在左侧时间序列查看。'}</p>
  </div>
}

export default function App() {
  const response = useJson<Dashboard>('/api/dashboard')
  const data = response?.data
  const [scene,setScene] = useState<Scene>('ecology')
  const [metric,setMetric] = useState<Metric>('ndvi')
  const [selected,setSelected] = useState<Station | null>(null)
  const [archive,setArchive] = useState<Dataset | null>(null)
  const [search,setSearch] = useState('')
  const [yearOverride,setYear] = useState<number | null>(null)
  const [playing,setPlaying] = useState(false)
  const [representative,setRepresentative] = useState<string | null>(null)
  const [layersOpen,setLayersOpen] = useState(false)
  const [relief,setRelief] = useState(true)
  const [rivers,setRivers] = useState(true)
  const [border,setBorder] = useState(false)
  const [expanded,setExpanded] = useState(false)
  const [entire,setEntire] = useState(false)
  const [mutedMap,setMutedMap] = useState(false)
  const [location,setLocation] = useState<MapLocation | null>(null)
  const [dispatchEventId,setDispatchEventId] = useState<string | null>(null)
  const [qualityIndex,setQualityIndex] = useState(0)
  const opsScene = scene === 'engineering' || scene === 'dispatch' ? scene : null
  const topic = scene === 'quality' || scene === 'emergency' ? scene : null
  const flood = scene === 'flood'
  const eco = scene === 'ecology'
  const ecology = useEcology(eco, selected?.id)
  const ecologicalLayer = useJson<RseiLayer>(eco && ecology.rseiLayer && ecology.rseiYear
    ? '/api/layers/rsei?year='+encodeURIComponent(ecology.rseiYear) : null)
  const regionalId = eco && ecology.activeScope.startsWith('subbasin:') ? ecology.activeScope.slice(9) : undefined
  const special = Boolean(opsScene || topic || flood || eco)
  const readOnly = document.documentElement.dataset.jinshaMode === 'public'
  const engineering = useEngineering(opsScene !== null)
  const replay = useFloodReplay(flood)
  const operationStations = useMemo(() => operationalStations(engineering.data, data?.stations ?? []),
    [engineering.data, data?.stations])
  const stationIds = useMemo(() => {
    if (opsScene) return operationStations.map(station=>station.id)
    if (flood || scene === 'water') return data?.runoffStations
    if (topic) return []
    if (eco && ecology.report && ecology.activeScope !== 'basin') return ecology.report.stations.map(station=>station.id)
  },[opsScene,operationStations,flood,scene,data?.runoffStations,topic,eco,ecology.report,ecology.activeScope])
  const detailEndpoint = selected && !special ? '/api/series?station='+encodeURIComponent(selected.id)+'&metric='+metric : null
  const series = useJson<Series>(detailEndpoint)

  const seriesPoints = useMemo<Point[]>(() => {
    if (!data) return []
    if (selected) return series?.data?.points ?? series?.data?.data ?? series?.data?.values ?? []
    if (metric === 'ndvi') return data.ndvi
    if (metric === 'discharge') return []
    const keys = { temperature:'temp', precipitation:'precip', evapotranspiration:'et' } as const
    const key = keys[metric]
    return data.climate.map(p => ({ year:p.year,value:p[key] }))
  },[data, metric, selected, series])
  const years = useMemo(() => {
    if (!data) return []
    return Array.from(new Set([...data.climate,...data.ndvi,...seriesPoints].map(point => point.year))).sort((a,b)=>a-b)
  },[data,seriesPoints])
  const year = yearOverride ?? years.at(-1) ?? 2025
  const index = Math.max(0,years.indexOf(year))
  const ndviColorData = useJson<{year:number,values:Record<string,number> }>(scene === 'vegetation' ? '/api/layers/ndvi?year='+year : null)
  const months = useJson<{rows:Array<{month:number;value:number|null}>;scope:string}>(
    data && scene !== 'data' && !special ? '/api/climate/months?year='+year+(selected?'&station='+encodeURIComponent(selected.id):'') : null
  )
  const flowStation = representative ?? data?.runoffStations?.[0]
  const flowPreview = useJson<Series>(scene==='overview' && !selected && flowStation
    ? '/api/series?metric=discharge&station='+encodeURIComponent(flowStation) : null)
  const flowPoints = flowPreview?.data?.values ?? []
  const flowForYear = flowPoints.find(point=>point.year===year)
  const annual = data?.climate.find(p => p.year === year)
  const ndvi = data?.ndvi.find(p => p.year === year)
  const current = seriesPoints.find(point => point.year === year)
  const overviewCover = data?.stations.map(coverFor).filter(isNumber) ?? []
  const averageCover = overviewCover.length ? overviewCover.reduce((a,b) => a+b, 0) / overviewCover.length : null
  const rollup = selected ? coverFor(selected) : averageCover
  const filtered = data?.stations.filter(st => (scene !== 'water' || stationIds?.includes(st.id))
    && [st.name,st.en,st.type,st.zone].some(value => value?.toLowerCase().includes(search.trim().toLowerCase()))) ?? []
  const period = seriesPoints.length ? seriesPoints[0].year+'–'+seriesPoints.at(-1)!.year : ''
  const activeMetric = metrics[metric]
  const marks = useMemo<Record<string,StationMark> | undefined>(() => {
    if (eco) return ecologyMarks(ecology.report)
    if (opsScene) return operationMarks(engineering.data, opsScene, dispatchEventId)
    if (flood) return Object.fromEntries((replay.frame?.stations ?? []).map(station => [station.id,{
      reading:format(station.value)+' m³/s', color:floodColors[station.level]
    }]))
    if (scene === 'water' && selected && metric === 'discharge' && isNumber(current?.value)) {
      return { [selected.id]:{ reading:format(current.value,1)+' m³/s',color:'#79d9ff' } }
    }
  },[eco,ecology.report,opsScene,engineering.data,dispatchEventId,flood,replay.frame,scene,selected,metric,current])

  useEffect(() => {
    if (!playing || !years.length) return
    const timer = window.setInterval(() => setYear(old => {
      const at = years.indexOf(old ?? year)
      if (at >= years.length - 1) { setPlaying(false);return years.at(-1)! }
      return years[Math.max(0,at+1)]
    }),850)
    return () => window.clearInterval(timer)
  },[playing,years,year])

  function changeScene(value: Scene) {
    setScene(value)
    setPlaying(false)
    setArchive(null)
    setMutedMap(false)
    setLocation(null)
    if (value === 'ecology' || value === 'engineering' || value === 'dispatch' || value === 'flood' || value === 'quality' || value === 'emergency') {
      setSelected(null)
      setEntire(false)
    }
    if (value === 'water') {
      setMetric('discharge')
      if (!selected || !data?.runoffStations?.includes(selected.id)) {
        setSelected(data?.stations.find(station=>data.runoffStations?.includes(station.id)) ?? null)
      }
    }
    if (value === 'vegetation' || value === 'overview') setMetric('ndvi')
  }

  function focusStation(station: Station) {
    setSelected(station)
    setLocation(null)
    setMutedMap(false)
  }

  function focusById(id: string) {
    const item = data?.stations.find(station => station.id === id)
    if (item) focusStation(item)
  }

  function focusLocation(value: MapLocation) {
    setLocation(value)
    setSelected(null)
    setMutedMap(false)
  }

  function selectBasin(id: string) {
    setSelected(null)
    setLocation(null)
    ecology.setScope('subbasin:'+id)
  }

  const topicPanel = (side: 'left' | 'right') => {
    if (eco) return <EcologyPane side={side} ecology={ecology} stations={data?.stations}
      onSelectStation={id=>id ? focusById(id) : setSelected(null)} onOpenData={()=>changeScene('data')}/>
    if (opsScene) return <OperationsPanel scene={opsScene} side={side} catalog={engineering.data} error={engineering.error}
      selectedId={selected?.id ?? null} onSelect={focusById} dispatchEventId={dispatchEventId} onSelectDispatchEvent={setDispatchEventId}/>
    if (topic) return <QualityResponse mode={topic} side={side} onLocate={focusLocation}
      qualityIndex={qualityIndex} onQualityIndexChange={setQualityIndex}/>
    if (flood) {
      const Panel = side === 'left' ? FloodLeft : FloodRight
      return <Panel replay={replay} selectedId={selected?.id ?? null} onSelectStation={focusById}/>
    }
  }

  function selectYear(value: number) {
    setYear(value)
    setPlaying(false)
  }

  function play() {
    if (!playing && year === years.at(-1)) setYear(years[0] ?? year)
    setPlaying(!playing)
  }

  return <main className={'workbench'+(special && !flood ? ' workbench-topic' : '')} data-scene={scene}>
    <header className="masthead">
      <div className="mast-left"><MountainSnow size={23}/><span>金沙江</span><small>流域生态研究</small></div>
      <div className="mast-title"><h1>金沙江智能生态评估</h1><span>JINSHA RIVER BASIN · DIGITAL TWIN</span></div>
      <div className="mast-right"><i className={data ? 'online' : ''}/><span>{data ? readOnly ? '公开数据已连接' : '本地数据已连接' : response?.error ? '数据连接异常' : '连接数据服务'}</span></div>
    </header>

    <div className={'stage'+ (mutedMap ? ' stage-browsing' : '')}>
      {data && <TerrainMap config={data.map} stations={data.stations} selected={selected} scene={scene} relief={relief} rivers={rivers}
        border={border} expanded={expanded} entire={entire} onSelect={focusStation} vegetation={ndviColorData?.data?.values}
        marks={marks} stationIds={stationIds} location={location} basinId={regionalId} onBasin={eco ? selectBasin : undefined}
        rsei={ecologicalLayer?.data ?? undefined}/>}
      <div className="stage-shade" aria-hidden="true"/>
      {scene==='data' && archive && <ArchivePane key={archive.id} dataset={archive} onClose={()=>setArchive(null)}/>}
      {!data && <p className="stage-message" role="status">{response?.error ? '未能读取新数据服务' : '正在加载流域档案'}</p>}

      <aside className="left-stack" aria-label="专题分析">
        {special ? topicPanel('left') : <>
        <section className="hud summary">
          <PanelTitle tag={String(year)}>{scene==='water' ? '径流摘要' : '年度摘要'}</PanelTitle>
          <div className="summary-grid">
            {scene === 'water' && metric === 'discharge' ? <div className="summary-hero">
              <span>{selected?.name ?? '代表站'}年均流量</span><strong>{format(current?.value,1)} <small>m³/s</small></strong>
              <small>GloFAS 模型再分析</small>
            </div> : <div className="summary-hero"><span>{selected?.name ?? '流域站点均值'} NDVI</span>
              <strong>{format(selected ? metric === 'ndvi' ? current?.value : undefined : ndvi?.value,3)}</strong>
              <small>MODIS 年度合成</small></div>}
            <div><span>流域年降水</span><strong>{format(annual?.precip)} <small>mm</small></strong></div>
            <div><span>流域年均温</span><strong>{format(annual?.temp,1)} <small>°C</small></strong></div>
            <div><span>{selected ? '本站林地占比' : '站点平均林地占比'}</span><strong>{format(rollup,1)} <small>%</small></strong></div>
          </div>
        </section>

        <section className="hud trends">
          <PanelTitle tag={period}>年度序列</PanelTitle>
          <div className="trend-title">
            <select aria-label="选择时序指标" value={metric} onChange={event => setMetric(event.target.value as Metric)}>
              {Object.entries(metrics).map(([id,meta]) => <option key={id} value={id}>{meta.name}</option>)}
            </select>
            <span>{activeMetric.unit}</span>
          </div>
          <TrendChart points={seriesPoints} year={year} color={activeMetric.color} onSelect={selectYear}/>
          <div className="trend-caption">{selected ? selected.name : metric === 'ndvi' ? '站点均值' : '流域面平均'} <b>{format(current?.value,activeMetric.digits)}</b>
            <small>{metric === 'discharge' && !selected ? '点击水文站查看可用径流序列' : series?.error ? '该站暂无此指标' : current?.value == null ? '该年暂无记录' : String(year)+' 年'}</small></div>
        </section>

        {scene !== 'data' && <section className="hud monthly">
          <PanelTitle tag={months?.data?.scope ?? selected?.name ?? '流域'}>逐月降水 · mm</PanelTitle>
          <MonthlyBars rows={months?.data?.rows ?? []}/>
        </section>}
        </>}
        <section className="hud layer-panel">
          <button className="panel-trigger" type="button" onClick={()=>setLayersOpen(!layersOpen)} aria-expanded={layersOpen}><Layers3 size={16}/> 地图图层 <ChevronRight size={16}/></button>
          {layersOpen && <div className="layer-controls">
            {([
              ['卫星影像',relief,setRelief],['金沙江干支流',rivers,setRivers],['子流域边界',border,setBorder],
              ['扩展河网',expanded,setExpanded]
            ] as const).map(([label,checked,control])=><label key={label}><span>{label}</span><input type="checkbox" checked={label==='子流域边界' && eco || checked} onChange={e=>control(e.target.checked)} disabled={label==='扩展河网' && !data?.map.expandedRiverUrl || label==='子流域边界' && eco}/></label>)}
          </div>}
        </section>
      </aside>

      <div className="map-title"><Waves size={16}/><span>{sceneCaptions[scene]}</span><small>{entire ? '全流域' : '地形窗口'}</small>
        {['ecology','overview','vegetation'].includes(scene) && <button type="button" onClick={()=>changeScene(eco?'overview':'ecology')}>
          {eco?'流域态势':'返回评估'}
        </button>}
        {eco && <button type="button" aria-pressed={ecology.rseiLayer} onClick={()=>{
          if (!ecology.rseiYear) ecology.setRseiYear('2025')
          ecology.setRseiLayer(!ecology.rseiLayer)
        }}>RSEI 图层</button>}
        {['overview','vegetation'].includes(scene) && <button type="button" className="vegetation-entry" aria-pressed={scene==='vegetation'}
          onClick={()=>changeScene(scene==='vegetation' ? 'overview' : 'vegetation')}><Leaf size={12}/>植被演变</button>}
        {data?.map.expandedRiverBounds && <button type="button" onClick={()=>{setEntire(!entire);setSelected(null);setLocation(null);if(!entire){setExpanded(true);setBorder(true)}}}>{entire ? '回到三维' : '查看全流域'}</button>}</div>
      <div className="map-footer">
        <span><i/> 金沙江干流</span>
        {!special && <span><i className="monitor-dot"/> 研究站点</span>}
        {opsScene && <span><i className="monitor-dot"/> 梯级水电工程</span>}
        {flood && <span className="flood-legend"><i className="monitor-dot"/> 历史模拟站点</span>}
        {eco && (ecologicalLayer?.data ? <span className="rsei-key" title="颜色分级从低到高，灰色表示无有效像元"><i/> {ecologicalLayer.data.year} RSEI</span> : <span><i className="monitor-dot"/> 评估站点</span>)}
        {location && <span><i className="location-dot"/> 档案位置</span>}
        <span className="map-provenance">SRTM · {readOnly ? 'NASA Blue Marble' : 'Esri'}{data?.map.context && ' · Mapzen'}</span>
        {scene==='vegetation' && <span>站点颜色表示 {year} 年 NDVI</span>}
        {expanded || data?.map.mainstemProductUrl ? <span>HydroRIVERS v1 · HydroSHEDS © WWF</span> : null}
        <button onClick={()=>setMutedMap(!mutedMap)}>{mutedMap ? '显示面板' : '专注地图'}</button>
      </div>

      <aside className="right-stack" aria-label="流域数据和站点">
        {special ? topicPanel('right') : scene === 'data' ? <section className="hud source-panel"><PanelTitle>数据目录</PanelTitle><SourceList catalog={data?.catalog ?? []} onSelect={setArchive}/></section> : <>
          {selected && <section className="hud station-inspector">
            <div className="panel-title"><h2>{selected.name}</h2>
              <button className="icon-btn" type="button" onClick={()=>setSelected(null)} aria-label="清除站点选择"><X size={16}/></button></div>
            <StationInformation station={selected} point={metric === 'ndvi' ? current : undefined}/>
          </section>}

          {scene==='overview' && !selected && flowStation && <section className="hud runoff-preview">
            <PanelTitle tag={String(year)}>代表站径流</PanelTitle>
            <div className="trend-title"><select aria-label="选择径流代表站" value={flowStation}
              onChange={event=>setRepresentative(event.target.value)}>
              {data?.stations.filter(station=>data.runoffStations?.includes(station.id)).map(station=>
                <option value={station.id} key={station.id}>{station.name}</option>)}
            </select><span>GloFAS 模拟</span></div>
            <div className="flow-value">{format(flowForYear?.value,1)} <span>m³/s</span></div>
            <TrendChart points={flowPoints} year={year} color="#79ceff" onSelect={selectYear}/>
          </section>}
          <section className="hud station-panel">
            <PanelTitle tag={data ? (scene==='water' ? stationIds?.length ?? 0 : data.stations.length)+' 站' : undefined}>
              {scene==='water' ? '径流档案站点' : '监测站点'}
            </PanelTitle>
            <label className="search"><Search size={15}/><input aria-label="搜索站点" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索站名或分区"/></label>
            <div className="station-list">
              {filtered.map(station => <button type="button" key={station.id} className={'station-row'+(selected?.id===station.id ? ' selected' : '')} onClick={()=>focusStation(station)}>
                <span className="station-icon"><MapPin size={15}/></span><span><b>{station.name}</b><small>{station.type} · {station.zone}</small></span>
                <span className="station-elevation">{format(station.elevation)} <small>m</small></span><ArrowUpRight size={13}/>
              </button>)}
              {!filtered.length && <p className="empty-list">{data ? '没有匹配的站点' : '正在读取站点'}</p>}
            </div>
          </section>
          {!selected && <section className="hud coverage-panel"><PanelTitle>档案覆盖</PanelTitle>
            <div className="coverage-body">
              <div className="coverage-ring" style={{background:'conic-gradient(#63befa 0 '+((data?.runoffStations?.length ?? 0)/Math.max(1,data?.stations.length ?? 1)*100)+'%,#203c59 0)'}}>
                <b>{data?.stations.length ?? '—'}<small>总览站点</small></b></div>
              <dl><div><dt><Waves size={13}/> 模型径流</dt><dd>{data?.runoffStations?.length ?? '—'} 站</dd></div>
                <div><dt><ChartNoAxesCombined size={13}/> 气候序列</dt><dd>{data ? data.climate.length : '—'} 年</dd></div></dl>
            </div>
          </section>}
        </>}
      </aside>
    </div>

    {flood ? <FloodTimeline replay={replay}/> : !special && <section className="timebar" aria-label="观测年份时间轴">
      <button type="button" onClick={play} className="play" aria-label={playing ? '暂停播放' : '播放年份'} disabled={!years.length}>{playing ? <Pause size={18}/> : <Play size={18}/>}</button>
      <div className="year"><small>观测年份</small><strong>{years.length ? year : '—'}</strong></div>
      <div className="scrubber"><input aria-label="观测年份" aria-valuetext={String(year)} type="range" min="0" max={Math.max(0, years.length-1)} value={index} onChange={event=>selectYear(years[Number(event.target.value)] ?? year)} disabled={!years.length}/>
        <div><span>{years[0]}</span><span>{years[Math.floor(years.length/2)]}</span><span>{years.at(-1)}</span></div></div>
      <div className="timeline-meta"><span>数据口径</span><b>{metric === 'ndvi' ? '遥感年度合成' : metric === 'discharge' ? '历史模型径流' : '气候再分析'}</b></div>
    </section>}
    <nav className="scene-nav" aria-label="流域专题">{scenes.map(({id,name,icon:Icon})=>
      <button type="button" key={id} aria-pressed={scene===id || id==='ecology' && ['overview','vegetation'].includes(scene)} onClick={()=>changeScene(id)}>
        <span className="nav-platform" aria-hidden="true"><Icon size={20}/></span><span>{name}</span></button>
    )}</nav>
  </main>
}
