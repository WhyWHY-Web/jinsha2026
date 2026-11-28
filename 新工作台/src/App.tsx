import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ChartNoAxesCombined, ChevronRight, Copy, Database, Download, FileText, FolderOpen as FolderIcon, Layers3, Leaf, MapPin, Maximize2, Minimize2, MountainSnow, Pause, Play, Search, Waves, X } from 'lucide-react'
import { TrendChart } from './TrendChart'
import { useEngineering, operationalStations, operationMarks } from './engineering-state'
import { useFloodReplay, floodColors } from './flood-state'
import { ecologyMarks, useEcology } from './ecology-state'
import { PanelHeader } from './PanelHeader'
import { indicatorMarks, screenWarnings, warningIndicators, type WarningIndicator } from './warning'
import type { Dashboard, Dataset, MapLocation, Metric, Point, RseiLayer, Scene, Series, Station, StationMark } from './data'
import { readViewQuery, writeViewQuery, type CameraView, type ViewQuery } from './view-query'
import { useLiveStatus,dateTime,type ForecastReply } from './live-state'
import { forecastDays,forecastUsable } from '../server/forecast-model'
import { useDialogFocus } from './dialog-focus'
import './styles.css'
import './workbench.css'

const TerrainMap = lazy(()=>import('./TerrainMap').then(module=>({default:module.TerrainMap})))
const ArchivePane = lazy(()=>import('./ArchivePane').then(module=>({default:module.ArchivePane})))
const EcologyPane = lazy(()=>import('./EcologyPane').then(module=>({default:module.EcologyPane})))
const OperationsPanel = lazy(()=>import('./operations').then(module=>({default:module.OperationsPanel})))
const FloodLeft = lazy(()=>import('./FloodPane').then(module=>({default:module.FloodLeft})))
const FloodRight = lazy(()=>import('./FloodPane').then(module=>({default:module.FloodRight})))
const FloodTimeline = lazy(()=>import('./FloodPane').then(module=>({default:module.FloodTimeline})))
const QualityResponse = lazy(()=>import('./QualityResponse').then(module=>({default:module.QualityResponse})))
const WarningLeft = lazy(()=>import('./WarningPane').then(module=>({default:module.WarningLeft})))
const WarningRight = lazy(()=>import('./WarningPane').then(module=>({default:module.WarningRight})))
const ForecastPane = lazy(()=>import('./ForecastPane').then(module=>({default:module.ForecastPane})))
const ResearchCenter = lazy(()=>import('./ResearchCenter').then(module=>({default:module.ResearchCenter})))
const AnalysisWorkspace = lazy(()=>import('./AnalysisWorkspace').then(module=>({default:module.AnalysisWorkspace})))

const sceneGroup = (value: Scene) => ['ecology','forecast','warning'].includes(value) ? '生态评估' : value==='vegetation' ? '地图探索' : value==='results' ? '成果中心' : '数据与方法'
const navScenes = [{id:'ecology',name:'生态评估',icon:Leaf},{id:'vegetation',name:'地图探索',icon:Layers3},
  {id:'methods',name:'数据与方法',icon:Database},{id:'results',name:'成果中心',icon:FolderIcon}] as const
const sceneCaptions: Record<Scene,string> = {
  ecology:'生态评估工作台', vegetation:'植被演变', water:'模型径流', engineering:'梯级工程',
  dispatch:'公开调度事实', flood:'历史洪水案例', quality:'水质报告', emergency:'白格历史案例', warning:'研究核查优先级', data:'数据资源',
  forecast:'未来七天气象驱动',methods:'数据与方法',results:'成果中心'
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
    ['历史台账 EEI', isNumber(eei) ? format(eei,1) : '—', typeof grade === 'string' ? grade+'级' : ''],
    ['坐标', format(station.lon,3) + ' E', format(station.lat,3) + ' N']
  ]
  return <div className="station-detail">
    <span className="detail-type">{station.type} · {station.zone}</span>
    <dl>{rows.map(([label,value,unit]) => <div key={label}><dt>{label}</dt><dd>{value} <small>{unit}</small></dd></div>)}</dl>
    <p>{point?.value != null ? point.year+' 年 NDVI '+format(point.value,3)+'。' : '选中年份的 NDVI 在左侧时间序列查看。'}</p>
  </div>
}

export default function App() {
  const [initialQuery] = useState(readViewQuery)
  const response = useJson<Dashboard>('/api/dashboard')
  const data = response?.data
  const [scene,setScene] = useState<Scene>(initialQuery.scene)
  const live=useLiveStatus()
  const sheet=scene==='methods' || scene==='results'
  const [analysis,setAnalysis]=useState(initialQuery.analysis)
  const [workspaceView,setWorkspaceView]=useState(new URLSearchParams(window.location.search).has('view')?initialQuery.workspaceView:'map')
  const [forecastBatch,setForecastBatch]=useState(initialQuery.forecastBatch)
  const [forecastDay,setForecastDay]=useState(initialQuery.forecastDay)
  const [forecastVersion,setForecastVersion]=useState(0)
  const [expectedRun,setExpectedRun]=useState(initialQuery.run)
  const [drawing,setDrawing]=useState(false)
  const [onlineImagery,setOnlineImagery]=useState(initialQuery.online)
  const [flatMap,setFlatMap]=useState(initialQuery.flat)
  const [helpOpen,setHelpOpen]=useState(()=>{try{return !localStorage.getItem('jinsha-onboarding-v1')}catch{return true}})
  const [helpElement,setHelpElement]=useState<HTMLElement|null>(null)
  const [drawerElement,setDrawerElement]=useState<HTMLElement|null>(null)
  useDialogFocus(helpElement,helpOpen,()=>closeHelp())
  useDialogFocus(drawerElement,Boolean(drawerElement),()=>setDrawer(null))
  const [metric,setMetric] = useState<Metric>(initialQuery.metric)
  const [selectedId,setSelectedId] = useState<string | null>(initialQuery.station)
  const selected = data?.stations.find(station=>station.id===selectedId) ?? null
  const setSelected = (station:Station | null) => setSelectedId(station?.id ?? null)
  const [archive,setArchive] = useState<Dataset | null>(null)
  const [search,setSearch] = useState('')
  const [yearOverride,setYear] = useState<number | null>(initialQuery.year)
  const [playing,setPlaying] = useState(false)
  const [comparison,setComparison] = useState(false)
  const [compareYearOverride,setCompareYear] = useState<number | null>(null)
  const [blend,setBlend] = useState(.5)
  const [layersOpen,setLayersOpen] = useState(false)
  const [relief,setRelief] = useState(initialQuery.relief)
  const [rivers,setRivers] = useState(initialQuery.rivers)
  const [border,setBorder] = useState(initialQuery.border)
  const [expanded,setExpanded] = useState(initialQuery.expanded)
  const [entire,setEntire] = useState(initialQuery.entire)
  const [mapView,setMapView] = useState<CameraView | null>(initialQuery.camera)
  const [mutedMap,setMutedMap] = useState(false)
  const [location,setLocation] = useState<MapLocation | null>(null)
  const [dispatchEventId,setDispatchEventId] = useState<string | null>(null)
  const [qualityIndex,setQualityIndex] = useState(0)
  const [drawer,setDrawer] = useState<'left' | 'right' | null>(null)
  const [largeScreen,setLargeScreen] = useState(false)
  const [compact,setCompact] = useState(() => window.innerWidth < 1100)
  const [mapIndicator,setMapIndicator] = useState<WarningIndicator>(initialQuery.mapIndicator)
  const [focusTick,setFocusTick] = useState(0)
  const [exporting,setExporting] = useState(false)
  const [exportMessage,setExportMessage] = useState('')
  const opsScene = scene === 'engineering' || scene === 'dispatch' ? scene : null
  const topic = scene === 'quality' || scene === 'emergency' ? scene : null
  const flood = scene === 'flood'
  const warning = scene === 'warning'
  const eco = scene === 'ecology'
  const future=scene==='forecast'
  const analysisWorkspace=eco || future
  const ecology = useEcology(eco || future || sheet, selected?.id,initialQuery)
  const previousContext=useRef('')
  useEffect(()=>{
    const context=JSON.stringify([selectedId,ecology.scope,ecology.bbox,ecology.year,ecology.compareYear,ecology.scenario])
    if(previousContext.current && previousContext.current!==context)setExpectedRun('')
    previousContext.current=context
  },[selectedId,ecology.scope,ecology.bbox,ecology.year,ecology.compareYear,ecology.scenario])
  const forecast=useJson<ForecastReply>(future ? '/api/live/forecast?'+new URLSearchParams({...(forecastBatch?{batch:forecastBatch}:{}),v:String(forecastVersion)}) : null)
  const forecastSnapshot=forecast?.data?.snapshot
  const forecastValid=forecastSnapshot && forecastUsable(forecastSnapshot)
  useEffect(()=>{if(future && !forecastBatch && forecastSnapshot)setForecastBatch(forecastSnapshot.id)},[future,forecastBatch,forecastSnapshot])
  useEffect(() => {
    if (initialQuery.rsei) ecology.setRseiLayer(true)
    if (initialQuery.rseiYear) ecology.setRseiYear(initialQuery.rseiYear)
  },[])
  const ecologicalLayer = useJson<RseiLayer>(eco && ecology.rseiLayer && ecology.rseiYear
    ? '/api/layers/rsei?year='+encodeURIComponent(ecology.rseiYear)+'&mask='+ecology.rseiMask : null)
  const regionalId = eco && ecology.activeScope.startsWith('subbasin:') ? ecology.activeScope.slice(9) : undefined
  const special = Boolean(opsScene || topic || flood || eco || future || sheet || warning)
  const readOnly = document.documentElement.dataset.jinshaMode === 'public'
  const engineering = useEngineering(opsScene !== null)
  const replay = useFloodReplay(flood)
  const [floodYearRestored,setFloodYearRestored] = useState(false)
  useEffect(() => {
    if (initialQuery.scene !== 'flood' || !replay.archive || floodYearRestored) return
    const match = replay.archive.events.find(item=>Number(item.peakDate.slice(0,4))===initialQuery.year)
    if (match) replay.selectEvent(match.id)
    setFloodYearRestored(true)
  },[initialQuery,replay.archive,floodYearRestored])
  const operationStations = useMemo(() => operationalStations(engineering.data, data?.stations ?? []),
    [engineering.data, data?.stations])
  const warningRows = useMemo(()=>screenWarnings(data?.stations ?? []),[data?.stations])
  const metricMarks = useMemo(()=>indicatorMarks(warningRows,mapIndicator),[warningRows,mapIndicator])
  const stationIds = useMemo(() => {
    if (opsScene) return operationStations.map(station=>station.id)
    if (flood || scene === 'water') return data?.runoffStations
    if (topic) return []
    if ((eco || future) && ecology.report && ecology.activeScope !== 'basin') return ecology.report.stations.map(station=>station.id)
  },[opsScene,operationStations,flood,scene,data?.runoffStations,topic,eco,future,ecology.report,ecology.activeScope])
  const detailEndpoint = selected && (!special || eco) ? '/api/series?station='+encodeURIComponent(selected.id)+'&metric='+metric : null
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
  const year = eco && ecology.year ? Number(ecology.year) : yearOverride ?? years.at(-1) ?? 2025
  useEffect(() => {
    if (!data) return
    const viewYear = eco || future || sheet ? ecology.year ? Number(ecology.year) : null : flood && replay.event ? Number(replay.event.peakDate.slice(0,4)) : year
    const view:ViewQuery = {scene,station:selectedId,year:viewYear,metric,relief,rivers,border,expanded,entire,
      mapIndicator,rsei:ecology.rseiLayer,rseiYear:ecology.rseiYear,camera:mapView,scope:ecology.scope,bbox:ecology.bbox,
      scenario:ecology.scenario,compareYear:ecology.compareYear,analysis,forecastBatch,forecastDay,run:expectedRun,online:onlineImagery,flat:flatMap,rseiMask:ecology.rseiMask,workspaceView}
    const url = writeViewQuery(view)
    if (url.href !== window.location.href) window.history.replaceState(null,'',url)
  },[data,scene,selectedId,year,metric,relief,rivers,border,expanded,entire,mapIndicator,ecology.year,ecology.rseiLayer,ecology.rseiYear,replay.event,mapView,
    ecology.scope,ecology.bbox,ecology.scenario,ecology.compareYear,analysis,forecastBatch,forecastDay,expectedRun,onlineImagery,flatMap,ecology.rseiMask,workspaceView])
  const index = Math.max(0,years.indexOf(year))
  const compareYear = compareYearOverride ?? years[Math.max(0,index-1)] ?? year
  const compareIndex = Math.max(0,years.indexOf(compareYear))
  const ndviColorData = useJson<{year:number,values:Record<string,number> }>(scene === 'vegetation' || comparison ? '/api/layers/ndvi?year='+year : null)
  const compareLayer = useJson<{year:number,values:Record<string,number> }>(comparison ? '/api/layers/ndvi?year='+compareYear : null)
  const mapComparison = useMemo(()=>comparison && ndviColorData?.data && compareLayer?.data ? {
    a:ndviColorData.data.values,b:compareLayer.data.values,blend
  } : null,[comparison,ndviColorData,compareLayer,blend])
  const months = useJson<{rows:Array<{month:number;value:number|null}>;scope:string}>(
    data && scene !== 'data' && !special ? '/api/climate/months?year='+year+(selected?'&station='+encodeURIComponent(selected.id):'') : null
  )
  const annual = data?.climate.find(p => p.year === year)
  const ndvi = data?.ndvi.find(p => p.year === year)
  const current = seriesPoints.find(point => point.year === year)
  const compared = seriesPoints.find(point => point.year === compareYear)
  const difference = isNumber(current?.value) && isNumber(compared?.value) ? current.value-compared.value : null
  const worsening = difference !== null && (metric === 'temperature' || metric === 'evapotranspiration' ? difference > 0 : difference < 0)
  const overviewCover = data?.stations.map(coverFor).filter(isNumber) ?? []
  const averageCover = overviewCover.length ? overviewCover.reduce((a,b) => a+b, 0) / overviewCover.length : null
  const rollup = selected ? coverFor(selected) : averageCover
  const filtered = data?.stations.filter(st => (scene !== 'water' || stationIds?.includes(st.id))
    && [st.name,st.en,st.type,st.zone].some(value => value?.toLowerCase().includes(search.trim().toLowerCase()))) ?? []
  const period = seriesPoints.length ? seriesPoints[0].year+'–'+seriesPoints.at(-1)!.year : ''
  const activeMetric = metrics[metric]
  const marks = useMemo<Record<string,StationMark> | undefined>(() => {
    if(future) return forecastValid && forecastSnapshot ? Object.fromEntries(forecastSnapshot.stations.map(station=>{
      const days=forecastDays(station),day=forecastDay?days.find(row=>row.date===forecastDay):days[0]
      return [station.id,{reading:day?.balance!=null?'P−ET₀ '+format(day.balance,1)+' mm':'缺测',color:day?.balance!=null && day.balance<0?'#e5bd79':'#79cfdf'}]
    })) : {}
    if (eco) return ecologyMarks(ecology.report)
    if (opsScene) return operationMarks(engineering.data, opsScene, dispatchEventId)
    if (flood) return Object.fromEntries((replay.frame?.stations ?? []).map(station => [station.id,{
      reading:format(station.value)+' m³/s', color:floodColors[station.level]
    }]))
    if (scene === 'water' && selected && metric === 'discharge' && isNumber(current?.value)) {
      return { [selected.id]:{ reading:format(current.value,1)+' m³/s',color:'#79d9ff' } }
    }
  },[eco,ecology.report,opsScene,engineering.data,dispatchEventId,flood,replay.frame,scene,selected,metric,current,future,forecastValid,forecastSnapshot,forecastDay])

  useEffect(() => {
    if (!playing || !years.length) return
    if (year===years.at(-1) && (!comparison || compareYear===years.at(-1))) { setPlaying(false);return }
    const timer = window.setInterval(() => {
      setYear(old=>years[Math.min(years.length-1,Math.max(0,years.indexOf(old ?? year))+1)])
      if (comparison) setCompareYear(old=>years[Math.min(years.length-1,Math.max(0,years.indexOf(old ?? compareYear))+1)])
    },850)
    return () => window.clearInterval(timer)
  },[playing,years,year,comparison,compareYear])

  useEffect(() => {
    const resize = () => {
      setCompact(window.innerWidth < 1100)
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.closest('input, textarea, select, dialog, [role="dialog"], [contenteditable="true"]')) return
      const index = Number(event.key) - 1
      if (index >= 0 && index < 4 && String(index + 1) === event.key && !helpOpen) {
        event.preventDefault()
        changeScene(navScenes[index].id)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })

  function changeScene(value: Scene, updateRoute = true) {
    if (updateRoute && value !== scene) window.history.pushState(null,'',writeViewQuery({...readViewQuery(),scene:value}))
    if (value==='vegetation' && eco) setYear(ecology.year ? Number(ecology.year) : null)
    if (value==='ecology' && (scene==='vegetation' || scene==='water')) ecology.setYear(String(year))
    setScene(value)
    setDrawing(false)
    setDrawer(null)
    setPlaying(false)
    setComparison(false)
    setArchive(null)
    setMutedMap(false)
    setLocation(null)
    if (value === 'ecology' || value === 'engineering' || value === 'dispatch' || value === 'flood' || value === 'quality' || value === 'emergency' || value === 'warning') {
      if(!['ecology','forecast','results','methods'].includes(value))setSelected(null)
    }
    if (value === 'water') {
      setMetric('discharge')
      if (!selected || !data?.runoffStations?.includes(selected.id)) {
        setSelected(data?.stations.find(station=>data.runoffStations?.includes(station.id)) ?? null)
      }
    }
    if (value === 'vegetation') setMetric('ndvi')
  }

  useEffect(() => {
    const onRoute = () => window.location.reload()
    window.addEventListener('popstate',onRoute)
    return () => window.removeEventListener('popstate',onRoute)
  },[])

  function focusStation(station: Station) {
    setSelected(station)
    setFocusTick(tick=>tick+1)
    setLocation(null)
    setMutedMap(false)
  }

  function focusById(id: string) {
    const item = data?.stations.find(station => station.id === id)
    if (item) focusStation(item)
  }

  function closeHelp() {setHelpOpen(false);try{localStorage.setItem('jinsha-onboarding-v1','seen')}catch{/* Private browsing can disable local storage. */}}
  function startTask(task:'current'|'change'|'future') {
    closeHelp();setExpectedRun('');ecology.setScenario('baseline');ecology.setScope('basin');ecology.setBbox('');setSelectedId('shigu');ecology.setYear('2025')
    ecology.setCompareYear(task==='change'?'2020':'');setAnalysis(task==='change'?'change':'current');changeScene(task==='future'?'forecast':'ecology')
    setWorkspaceView('map')
  }
  async function refreshLive() {
    if(readOnly)throw new Error('静态网站只能读取发布时的资料快照，请在本机更新后重新导出网站。')
    const result=await fetch('/api/live/refresh',{method:'POST'})
    if(!result.ok)throw new Error('资料检查未能提交，请重试')
    live.refresh()
  }
  async function saveCurrent() {
    try {
      const {saveRun,assessmentEvidence,forecastEvidence}=await import('./saved-runs')
      if(future && forecastSnapshot && forecastValid && ecology.report?.stations.length) {
        const station=forecastSnapshot.stations.find(row=>ecology.report!.stations.some(item=>item.id===row.id))
        if(!station || forecastDay && !forecastDays(station).some(row=>row.date===forecastDay))throw new Error('请选择本批次内有覆盖的研究格点和有效日期')
        const evidence=await forecastEvidence(forecastSnapshot,{scope:ecology.activeScope,bbox:ecology.bbox,day:forecastDay},window.location.href)
        evidence.title=ecology.report.scope.name+' · 七天气象驱动'+(forecastDay?' · '+forecastDay:'');saveRun(evidence)
      } else if(eco && ecology.report) {saveRun(assessmentEvidence(ecology.report,window.location.href));setExpectedRun(ecology.report.run.sha256)}
      else throw new Error('请先在生态评估或未来七天页面生成可用结果')
      setExportMessage('成果已保存，可在成果中心导出完整证据包')
    }catch(error){setExportMessage(error instanceof Error?error.message:String(error))}
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
    if (warning) return side === 'left' ? <WarningLeft rows={warningRows}/> :
      <WarningRight rows={warningRows} indicator={mapIndicator} selectedId={selected?.id ?? null} onSelect={focusStation}/>
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
    ecology.setYear(String(value))
    setPlaying(false)
  }

  function play() {
    if (!playing && year === years.at(-1)) setYear(years[0] ?? year)
    if (!playing && comparison && compareYear===years.at(-1)) setCompareYear(years[0] ?? compareYear)
    setPlaying(!playing)
  }


  async function runExport(kind:'png'|'pdf') {
    let element = document.querySelector<HTMLElement>('.workbench')
    if (!element || !data || exporting) return
    if(eco && !ecology.report){setExportMessage('请等待本次评估完成后导出');return}
    if(future && !forecastValid){setExportMessage('暂无有效预报，请先检查资料更新');return}
    const mapSurface=element.querySelector('.map-surface')
    const mapUnavailable=Boolean(mapSurface && mapSurface.getAttribute('data-map-status') !== 'ready')
    if (mapUnavailable && kind==='png') {setExportMessage('地图尚未加载完成，请稍后导出');return}
    if (mapUnavailable && kind==='pdf') {
      const summary=element.querySelector<HTMLElement>('.analysis-summary')
      if (!summary) {setExportMessage('地图尚未加载完成，请稍后导出');return}
      element=summary
    }
    setExporting(true);setExportMessage('正在生成'+(kind==='png'?'图片':'简报')+'…')
    try {
      const {exportPng,exportPdf} = await import('./export-view')
      const {assessmentRows}=await import('./assessment-export')
      const reportYear = flood && replay.event ? Number(replay.event.peakDate.slice(0,4)) : eco ? ecology.report?.year ?? year : year
      const reportAnnual = data.climate.find(item=>item.year===reportYear)
      const reportNdvi = data.ndvi.find(item=>item.year===reportYear)
      const reportCurrent = seriesPoints.find(item=>item.year===reportYear)
      const futureStation=forecastSnapshot?.stations.find(row=>row.id===selectedId) ?? forecastSnapshot?.stations.find(row=>ecology.report?.stations.some(station=>station.id===row.id))
      const rows:import('./export-view').ExportRow[] = eco && ecology.report ? assessmentRows(ecology.report) : future ? [
        ['分析范围',ecology.report?.scope.name ?? '当前范围',ecology.activeScope],['预报批次',forecastSnapshot?.id ?? '—','源起报时间未提供'],
        ['抓取时间',dateTime(forecastSnapshot?.retrievedAt),'非起报时间'],['有效至',dateTime(forecastSnapshot?.validTo),'北京时间'],
        ['所选研究格点',futureStation?.name ?? '无覆盖','格点模型预报'],
        ['选择日期',forecastDay || '全部有效时段','北京时间'],
        ...(futureStation ? forecastDays(futureStation).filter(row=>!forecastDay || row.date===forecastDay).flatMap(row=>[[''+row.date+' 降水',format(row.precipitation,2),'mm / '+row.hours+'h'],
          [''+row.date+' P−ET₀',format(row.balance,2),'mm；非土壤水分收支']] as import('./export-view').ExportRow[]) : []),
      ] : [
        ['流域 '+reportYear+' 年降水量',format(reportAnnual?.precip),'mm'],['流域 '+reportYear+' 年均气温',format(reportAnnual?.temp,1),'°C'],
        ['站点均值 '+reportYear+' 年 NDVI',format(reportNdvi?.value,3),'无量纲'],[selected?'本站林地占比':'站点平均林地占比',format(rollup,1),'%'],
        [activeMetric.name,format(reportCurrent?.value,activeMetric.digits),activeMetric.unit],
        ['监测站点',format(data.stations.length),'站'],
        ...(flood && replay.event ? [
          ['洪峰日期',replay.event.peakDate,'UTC'],['峰值流量',format(replay.event.peak),'m³/s'],
          ['超参考天数',format(replay.event.daysAbove),'天'],
        ] as import('./export-view').ExportRow[] : []),
      ]
      const view = {element,topic:sceneCaptions[scene],station:(eco || future) ? ecology.report?.scope.name ?? '当前范围' : selected?.name ?? '全流域',year:future?'未来七天':eco && ecology.report?.year == null ? '台账基准' : reportYear,metric:future?'气象驱动（非生态灾害概率）':flood?'历史模拟流量':eco?'EEI 经验分 · '+ecology.report?.scenario.name:activeMetric.name,
        rows,method:mapUnavailable?'地图未能捕获；本简报保留评估摘要、指标与来源。'+(ecology.report?.method ?? '气象驱动证据'):flood ? replay.archive?.method ?? '历史模型径流' : eco ? ecology.report?.method ?? '站点生态评估档案' : metric==='ndvi'?'MODIS 年度合成':metric==='discharge'?'GloFAS 历史模型径流':'年度档案汇总；当前筛选以页面显示为准',
        source:future?'Open-Meteo Forecast API v1；源起报时间未提供；生态胁迫模型未校准':flood ? replay.archive?.source ?? 'GloFAS 模型再分析' : scene==='ecology'?'生态评估输入快照；'+ecology.report?.modelCard.eeiRange:metric==='discharge'?'GloFAS 模型再分析':'流域气候、NDVI 与站点档案',
        url:window.location.href,run:eco ? ecology.report ?? undefined : undefined}
      await (kind==='png'?exportPng(view):exportPdf(view))
      setExportMessage(kind==='png'?'PNG 已下载':'PDF 简报已下载')
    } catch (error) {setExportMessage('导出失败：'+(error instanceof Error ? error.message : String(error)))}
    finally {setExporting(false)}
  }

  async function copyLink() {
    try {await navigator.clipboard.writeText(window.location.href);setExportMessage('链接已复制')}
    catch {setExportMessage('复制失败，请从地址栏复制链接')}
  }
  const mapCanvas=data && <Suspense fallback={<p className="stage-message" role="status">正在加载地图</p>}><TerrainMap config={data.map} stations={data.stations} selected={selected} scene={scene} relief={relief} rivers={rivers}
    border={border} expanded={expanded} entire={entire} onSelect={focusStation} vegetation={comparison ? undefined : ndviColorData?.data?.values}
    marks={marks} metricMarks={analysisWorkspace?undefined:metricMarks} stationIds={stationIds} location={location} basinId={regionalId} onBasin={eco ? selectBasin : undefined} focusTick={focusTick}
    rsei={ecologicalLayer?.data ?? undefined} compare={mapComparison}
    initialView={mapView} onViewChange={setMapView} online={onlineImagery} flat={flatMap} onFlatChange={setFlatMap}
    drawing={drawing} bbox={ecology.activeScope==='bbox'?ecology.bbox:undefined} onBounds={value=>{ecology.setBbox(value);ecology.setScope('bbox');setSelected(null);setDrawing(false)}}/></Suspense>
  const ecologyPane=(side:'setup'|'results'|'right'|'summary'|'station-evidence')=><EcologyPane side={side} ecology={ecology} stations={data?.stations}
    onSelectStation={id=>{id?focusById(id):setSelected(null)}} onOpenData={()=>changeScene('methods')}/>
  const forecastPane=(side:'setup'|'results'|'right'|'summary')=><ForecastPane side={side} ecology={ecology} stations={data?.stations ?? []} reply={forecast?.data ?? null} error={forecast?.error ?? false}
    day={forecastDay} onDay={setForecastDay} onStation={id=>id?focusById(id):setSelected(null)} onSave={()=>void saveCurrent()} onLatest={()=>{setForecastBatch('');setForecastVersion(v=>v+1)}}/>
  const ecologicalTasks=<div className="ecology-tasks">
    <div className="task-actions" aria-label="生态评估内的分析任务">{(['current','change','future','sensitivity'] as const).map(task=><button key={task} type="button" aria-pressed={task==='future'?future:eco && analysis===task} onClick={()=>{
      if(task==='future')changeScene('forecast')
      else {changeScene('ecology');setAnalysis(task);if(task==='change'){ecology.setScenario('baseline');if(!ecology.compareYear)ecology.setCompareYear('2020');if(!ecology.year)ecology.setYear('2025')}
        if(task==='current'){ecology.setCompareYear('');ecology.setScenario('baseline')}if(task==='sensitivity' && ecology.scenario==='baseline')ecology.setScenario('restoration')}
      setWorkspaceView('map')
    }}>{{current:'年度状态',change:'变化分析',future:'未来七天',sensitivity:'敏感性'}[task]}</button>)}</div>
    <p className="task-scope"><b>{selected?.name ?? ecology.report?.scope.name ?? '全流域研究站点'}</b><span>{future?'模型预报 · '+(forecastDay || '未来七天'):ecology.year?ecology.year+' 年历史研究资料':'台账多年基准'}</span></p>
    {eco && expectedRun && ecology.report && ecology.report.run.sha256!==expectedRun && <p className="run-mismatch" role="alert">原运行与当前输入不一致，请导入原证据 JSON 核对。当前结果保留独立运行号。</p>}
  </div>

  return <div className={'screen-frame research-workbench'+(largeScreen ? ' large-screen' : '')}>
  <main className={'workbench workbench-status'+(special && !flood && !warning ? ' workbench-topic' : '')+(warning ? ' workbench-warning' : '')+(comparison && !special ? ' workbench-compare' : '')} data-scene={scene} inert={helpOpen}>
    <header className="masthead">
      <div className="mast-brand"><MountainSnow size={22}/><h1>金沙江生态工作台</h1></div>
    <nav className="scene-nav primary-navigation" aria-label="主导航">{navScenes.map(({id,name,icon:Icon},index)=><button type="button" key={id}
      aria-pressed={sceneGroup(scene)===name} onClick={()=>changeScene(id)} title={`${index+1} · ${name}`}><Icon size={19}/><span>{name}</span><kbd>{index+1}</kbd></button>)}</nav>
      <div className="mast-right">
        <div className="mast-actions">

          <button type="button" onClick={copyLink} title="复制当前视图链接"><Copy size={14}/>复制链接</button>
          {!analysisWorkspace && !sheet && <><button type="button" onClick={()=>void runExport('png')} disabled={!data || exporting} title="导出当前视图 PNG"><Download size={14}/>PNG</button>
          <button type="button" onClick={()=>void runExport('pdf')} disabled={!data || exporting} title="导出 PDF 简报"><FileText size={14}/>PDF</button></>}
          <button type="button" onClick={()=>setHelpOpen(true)}>使用帮助</button>
        </div>
        {exportMessage && <span className="export-message" role="status">{exportMessage}</span>}
        <button className="screen-toggle" type="button" onClick={()=>setLargeScreen(!largeScreen)} aria-pressed={largeScreen} title={largeScreen ? '退出大屏模式' : '进入大屏模式'}>{largeScreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>{largeScreen ? '退出大屏' : '大屏模式'}</span></button>
        <div className="connection-state"><span>{data ? readOnly ? '网站资料快照' : '本地研究服务' : response?.error ? '数据连接异常' : '连接数据服务'}</span><small>实际遥测未接入</small></div>
      </div>
    </header>

    <div className={'stage'+ (mutedMap ? ' stage-browsing' : '')}>
      {drawer && !analysisWorkspace && <button type="button" className="drawer-scrim" aria-label="关闭面板" onClick={()=>setDrawer(null)}/>}
      {!sheet && !analysisWorkspace && mapCanvas}
      <div className="stage-shade" aria-hidden="true" hidden={analysisWorkspace || sheet}/>
      {analysisWorkspace && <Suspense fallback={<p className="stage-message">正在准备生态研究工作区</p>}><AnalysisWorkspace compact={compact} tasks={ecologicalTasks}
        context={<>
          <label>范围<select aria-label="工作区分析范围" value={ecology.activeScope} onChange={event=>{const value=event.target.value;if(value.startsWith('station:'))focusById(value.slice(8));else{ecology.setScope(value);setSelected(null)}}}>
            {(ecology.options?.regions ?? [{id:'basin',name:'全流域研究站点',count:0}]).filter(region=>!region.id.startsWith('station:') && region.id!=='bbox').map(region=><option key={region.id} value={region.id}>{region.name}</option>)}
            {ecology.activeScope==='bbox' && <option value="bbox">当前框选范围</option>}
            <optgroup label="单站分析">{data?.stations.map(station=><option key={station.id} value={'station:'+station.id}>{station.name}</option>)}</optgroup>
          </select></label>
          {!future ? <label>年份<select aria-label="工作区分析年份" value={ecology.year} onChange={event=>{ecology.setYear(event.target.value);setYear(event.target.value?Number(event.target.value):null)}}><option value="">台账基准</option>{ecology.options?.years.slice().reverse().map(value=><option key={value} value={value}>{value}</option>)}</select></label>:
            <span className="context-provenance">模型预报 · {forecastDay || '未来七天'} · 固定批次</span>}
          {eco && analysis==='change' && <label>对照<select aria-label="工作区对照年份" value={ecology.compareYear} onChange={event=>ecology.setCompareYear(event.target.value)}><option value="">关闭</option>{ecology.options?.years.slice().reverse().map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
          {eco && analysis==='sensitivity' && <label>情景<select aria-label="工作区评估情景" value={ecology.scenario} onChange={event=>ecology.setScenario(event.target.value)}>{ecology.options?.scenarios.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        </>}
        summary={future?forecastPane('summary'):ecologyPane('summary')}
        stationEvidence={eco?{selection:ecology.activeScope+'|'+ecology.year,content:ecologyPane('station-evidence')}:undefined}
        stations={<>
          {selected && <section className="workspace-selection"><b>{selected.name}</b><button type="button" onClick={()=>setSelected(null)}>清除站点选择</button><StationInformation station={selected} point={metric==='ndvi'?current:undefined}/></section>}
          <label className="station-search"><Search size={15}/><input aria-label="搜索研究站点" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索站名或分区"/></label>
          <div className="station-list">{filtered.map(station=><button key={station.id} type="button" className={'station-row'+(station.id===selectedId?' selected':'')} aria-pressed={station.id===selectedId} onClick={()=>focusStation(station)}><MapPin size={15}/><span><b>{station.name}</b><small>{station.zone}</small></span><ArrowUpRight size={14}/></button>)}{!filtered.length && <p>没有匹配的站点</p>}</div>
        </>}
        trend={!future && ecology.year && <>
          <div className="trend-title"><b>{selected?.name ?? (ecology.activeScope==='basin'?'全流域站点':'所选范围')} · 年度证据</b><select aria-label="评估时序指标" value={metric} onChange={event=>setMetric(event.target.value as Metric)}>{Object.entries(metrics).map(([id,meta])=><option key={id} value={id}>{meta.name}</option>)}</select><span>{activeMetric.unit}</span></div>
          {(selected || ecology.activeScope==='basin')?<><TrendChart points={seriesPoints} year={year} color={activeMetric.color} onSelect={selectYear} label={(selected?.name ?? '全流域')+' · '+activeMetric.name} unit={activeMetric.unit}/><p className="trend-caption">{selected?.name ?? (metric==='ndvi'?'站点均值':'流域面平均')} · {year} 年 · {format(current?.value,activeMetric.digits)} {activeMetric.unit}{series?.error?' · 该站暂无此指标':''} · 年度证据，非 EEI 时序</p></>:<p className="trend-caption">所选范围暂无对应年度时序。请点选研究站点查看，不以全流域曲线替代。</p>}
        </>}

        setup={future?forecastPane('setup'):ecologyPane('setup')} results={future?<>{forecastPane('results')}{forecastPane('right')}</>:ecologyPane('results')}
        tools={ecologyPane('right')} map={mapCanvas} view={workspaceView} onView={setWorkspaceView} onSave={()=>void saveCurrent()} onExport={kind=>void runExport(kind)} pending={exporting}
        onMethods={()=>changeScene('methods')} mapControls={<><button type="button" aria-pressed={drawing} onClick={()=>setDrawing(!drawing)}>{drawing?'取消框选':'地图框选'}</button>
          {eco && <button type="button" aria-pressed={ecology.rseiLayer} onClick={()=>{if(!ecology.rseiYear)ecology.setRseiYear('2025');ecology.setRseiLayer(!ecology.rseiLayer)}}>RSEI 共同覆盖</button>}
          <label><input type="checkbox" checked={onlineImagery} onChange={event=>setOnlineImagery(event.target.checked)}/>EOX 在线影像</label>
          <button type="button" onClick={()=>{setEntire(!entire);if(!entire){setExpanded(true);setBorder(true)}}}>{entire?'研究窗口':'查看全流域'}</button>
          <details className="workspace-layers"><summary>图层</summary><div>{([['地形影像',relief,setRelief],['河网',rivers,setRivers],['子流域边界',border,setBorder],['扩展河网',expanded,setExpanded]] as const).map(([label,checked,control])=><label key={label}><input type="checkbox" checked={checked} onChange={event=>control(event.target.checked)}/>{label}</label>)}</div></details>
          {drawing && <span>在地图按住并拖动，或在分析条件中输入范围坐标</span>}</>}/></Suspense>}
      {sheet && <Suspense fallback={<p className="stage-message">正在读取研究工作区</p>}><ResearchCenter key={scene} mode={scene} status={live.status} error={live.error} report={ecology.report}
        onNavigate={changeScene} onRefresh={refreshLive}/></Suspense>}
      {scene==='data' && archive && <Suspense fallback={<p className="stage-message">正在加载档案</p>}><ArchivePane key={archive.id} dataset={archive} onClose={()=>setArchive(null)}/></Suspense>}
      {!data && <p className="stage-message" role="status">{response?.error ? '未能读取新数据服务' : '正在加载流域档案'}</p>}

      {!analysisWorkspace && <aside ref={compact && drawer==='left'?setDrawerElement:undefined} className={'left-stack'+(drawer==='left' ? ' drawer-open' : '')} aria-label="专题分析" role={compact && drawer==='left'?'dialog':undefined} aria-modal={compact && drawer==='left'?true:undefined} inert={compact && drawer!=='left'}>
        {compact && drawer==='left' && <button type="button" className="drawer-close" onClick={()=>setDrawer(null)}>关闭分析面板</button>}
        {special ? <Suspense fallback={<p className="hud panel-loading">正在加载专题</p>}>{topicPanel('left')}</Suspense> : <>
        <section className="hud summary">
          <PanelHeader title={scene==='water' ? '径流摘要' : '年度摘要'} tag={String(year)}/>
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
          <PanelHeader title="年度序列" tag={period}/>
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
          <PanelHeader title="逐月降水 · mm" tag={months?.data?.scope ?? selected?.name ?? '流域'}/>
          <MonthlyBars rows={months?.data?.rows ?? []}/>
        </section>}
        </>}
        <section className="hud layer-panel">
          <button className="panel-trigger" type="button" onClick={()=>setLayersOpen(!layersOpen)} aria-expanded={layersOpen}><Layers3 size={16}/> 地图图层 <ChevronRight size={16}/></button>
          {layersOpen && <div className="layer-controls">
            <label><span>EOX 2024 在线多级影像</span><input type="checkbox" checked={onlineImagery} onChange={e=>setOnlineImagery(e.target.checked)}/></label>
            {([
              ['卫星影像',relief,setRelief],['金沙江干支流',rivers,setRivers],['子流域边界',border,setBorder],
              ['扩展河网',expanded,setExpanded]
            ] as const).map(([label,checked,control])=><label key={label}><span>{label}</span><input type="checkbox" checked={label==='子流域边界' && eco || checked} onChange={e=>control(e.target.checked)} disabled={label==='扩展河网' && !data?.map.expandedRiverUrl || label==='子流域边界' && eco}/></label>)}
          </div>}
        </section>
      </aside>}

      <div className="map-title" hidden={analysisWorkspace}><Waves size={16}/><span>{sceneCaptions[scene]}</span><small>{entire ? '全流域' : '地形窗口'}</small>
        {compact && <button type="button" onClick={()=>setDrawer(drawer==='right'?null:'right')}>证据与工具</button>}
        <label className="map-indicator">数值 <select aria-label="地图气泡指标" value={mapIndicator} onChange={event=>setMapIndicator(event.target.value as WarningIndicator)}>
          {(Object.keys(warningIndicators) as WarningIndicator[]).map(id=><option key={id} value={id}>{warningIndicators[id].name}</option>)}
        </select></label>
        {['ecology','vegetation','forecast'].includes(scene) && <button type="button" onClick={()=>changeScene(eco?'vegetation':'ecology')}>
          {eco?'地图探索':'返回评估'}
        </button>}
        {eco && <button type="button" aria-pressed={ecology.rseiLayer} onClick={()=>{
          if (!ecology.rseiYear) ecology.setRseiYear('2025')
          ecology.setRseiLayer(!ecology.rseiLayer)
        }}>RSEI 图层</button>}
        {(eco || future) && <button type="button" aria-pressed={drawing} onClick={()=>setDrawing(!drawing)}>{drawing?'取消框选':'地图框选'}</button>}
        {drawing && <span role="status">按住地图拖动选择范围，也可在分析面板输入坐标</span>}
        {data?.map.expandedRiverBounds && <button type="button" onClick={()=>{setEntire(!entire);setSelected(null);setLocation(null);if(!entire){setExpanded(true);setBorder(true)}}}>{entire ? '回到三维' : '查看全流域'}</button>}</div>
      <div className="map-footer" hidden={analysisWorkspace}>
        <span><i/> 金沙江干流</span>
        {!special && <span><i className="monitor-dot"/> 研究站点</span>}
        {opsScene && <span><i className="monitor-dot"/> 梯级水电工程</span>}
        {flood && <span className="flood-legend"><i className="monitor-dot"/> 历史模拟站点</span>}
        {warning && <span><i className="monitor-dot"/> 相对分位筛查 · 非实时</span>}
        {eco && (ecologicalLayer?.data ? <span className="rsei-key" title="颜色分级从低到高，灰色表示无有效像元"><i/> {ecologicalLayer.data.year} RSEI · {ecologicalLayer.data.mask==='common'?'八期共同覆盖':'各期覆盖'}</span> : <span><i className="monitor-dot"/> 评估站点</span>)}
        {location && <span><i className="location-dot"/> 档案位置</span>}
        <span className="map-provenance">DEM · Mapzen / SRTM · 地形 1×；河流符号非实宽</span>
        {scene==='vegetation' && <span>站点颜色表示 {year} 年 NDVI</span>}
        {expanded || data?.map.mainstemProductUrl ? <span>HydroRIVERS v1 · HydroSHEDS © WWF</span> : null}
        <button onClick={()=>setMutedMap(!mutedMap)}>{mutedMap ? '显示面板' : '专注地图'}</button>
      </div>

      {!analysisWorkspace && <aside ref={compact && drawer==='right'?setDrawerElement:undefined} className={'right-stack'+(drawer==='right' ? ' drawer-open' : '')} aria-label="流域数据和站点" role={compact && drawer==='right'?'dialog':undefined} aria-modal={compact && drawer==='right'?true:undefined} inert={compact && drawer!=='right'}>
        {compact && drawer==='right' && <button type="button" className="drawer-close" onClick={()=>setDrawer(null)}>关闭证据面板</button>}
        <nav className="scene-breadcrumb" aria-label="当前位置"><span>金沙江</span><ChevronRight size={12}/><span>{sceneGroup(scene)}</span><ChevronRight size={12}/><strong>{sceneCaptions[scene]}</strong>{selected && <><ChevronRight size={12}/><strong>{selected.name}</strong></>}</nav>
        {comparison && !special && <section className="hud compare-panel" aria-label="A/B 差值面板"><PanelHeader title="A/B 差值" tag={activeMetric.name}/>
          <dl><div><dt>现值 · {year}</dt><dd>{format(current?.value,activeMetric.digits)}</dd></div>
            <div><dt>对照 · {compareYear}</dt><dd>{format(compared?.value,activeMetric.digits)}</dd></div>
            <div><dt>差值</dt><dd className={worsening?'worse':''}>{difference===null?'—':(difference>0?'+':'')+format(difference,activeMetric.digits)}</dd></div>
            <div><dt>变化率</dt><dd className={worsening?'worse':''}>{difference===null || !compared?.value?'—':(difference>0?'+':'')+format(difference/Math.abs(compared.value)*100,1)+'%'}</dd></div></dl>
        </section>}
        {special ? <Suspense fallback={<p className="hud panel-loading">正在加载专题</p>}>{topicPanel('right')}</Suspense> : scene === 'data' ? <section className="hud source-panel"><PanelHeader title="数据目录"/><SourceList catalog={data?.catalog ?? []} onSelect={setArchive}/></section> : <>
          {selected && <section className="hud station-inspector">
            <PanelHeader title={selected.name} actions={<button className="icon-btn" type="button" onClick={()=>setSelected(null)} aria-label="清除站点选择"><X size={16}/></button>}/>
            <StationInformation station={selected} point={metric === 'ndvi' ? current : undefined}/>
          </section>}

          <section className="hud station-panel">
            <PanelHeader title={scene==='water' ? '径流档案站点' : '监测站点'} tag={data ? (scene==='water' ? stationIds?.length ?? 0 : data.stations.length)+' 站' : undefined}/>
            <label className="search"><Search size={15}/><input aria-label="搜索站点" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索站名或分区"/></label>
            <div className="station-list">
              {filtered.map(station => <button type="button" key={station.id} className={'station-row'+(selected?.id===station.id ? ' selected' : '')} onClick={()=>focusStation(station)}>
                <span className="station-icon"><MapPin size={15}/></span><span><b>{station.name}</b><small>{station.type} · {station.zone}</small></span>
                <span className="station-elevation">{format(station.elevation)} <small>m</small></span><ArrowUpRight size={13}/>
              </button>)}
              {!filtered.length && <p className="empty-list">{data ? '没有匹配的站点' : '正在读取站点'}</p>}
            </div>
          </section>
          {!selected && <section className="hud coverage-panel"><PanelHeader title="档案覆盖"/>
            <div className="coverage-body">
              <div className="coverage-ring" style={{background:'conic-gradient(#63befa 0 '+((data?.runoffStations?.length ?? 0)/Math.max(1,data?.stations.length ?? 1)*100)+'%,#203c59 0)'}}>
                <b>{data?.stations.length ?? '—'}<small>总览站点</small></b></div>
              <dl><div><dt><Waves size={13}/> 模型径流</dt><dd>{data?.runoffStations?.length ?? '—'} 站</dd></div>
                <div><dt><ChartNoAxesCombined size={13}/> 气候序列</dt><dd>{data ? data.climate.length : '—'} 年</dd></div></dl>
            </div>
          </section>}
        </>}
      </aside>}
    </div>

    <div className="timeline-dock">
      <div className="timeline-row">
        <div className="timeline-stations"><small>研究站点</small><strong>{data?.stations.length ?? '—'}<small> 站</small></strong></div>
        {flood ? <Suspense fallback={null}><FloodTimeline replay={replay}/></Suspense> : !special ? <section className={'timebar'+(comparison?' compare-on':'')} aria-label="观测年份时间轴">
      <button type="button" onClick={play} className="play" aria-label={playing ? '暂停播放' : comparison ? '同步播放 A/B' : '播放年份'} disabled={!years.length}>{playing ? <Pause size={18}/> : <Play size={18}/>}</button>
      {comparison ? <div className="compare-axes">
        {([['A 现值',year,index,(value:number)=>selectYear(value)],['B 对照',compareYear,compareIndex,(value:number)=>{setCompareYear(value);setPlaying(false)}]] as const).map(([label,value,at,change])=><div className="compare-axis" key={label}>
          <span>{label}</span><strong>{value}</strong><div className="scrubber"><input aria-label={label+'年份'} type="range" min="0" max={Math.max(0,years.length-1)} value={at}
            onChange={event=>change(years[Number(event.target.value)] ?? value)} disabled={!years.length}/></div></div>)}
        <label className="compare-blend">NDVI 图层 A/B <input aria-label="A/B 图层透明度" type="range" min="0" max="100" value={Math.round(blend*100)} onChange={event=>setBlend(Number(event.target.value)/100)}/></label>
      </div> : <><div className="year"><small>观测年份</small><strong>{years.length ? year : '—'}</strong></div>
        <div className="scrubber"><input aria-label="观测年份" aria-valuetext={String(year)} type="range" min="0" max={Math.max(0, years.length-1)} value={index} onChange={event=>selectYear(years[Number(event.target.value)] ?? year)} disabled={!years.length}/>
          <div><span>{years[0]}</span><span>{years[Math.floor(years.length/2)]}</span><span>{years.at(-1)}</span></div></div></>}
      <button type="button" className="compare-toggle" aria-pressed={comparison} onClick={()=>{setComparison(!comparison);setPlaying(false);if(!comparison)setCompareYear(years[Math.max(0,index-1)] ?? year)}}>A/B 对比 {comparison?'开':'关'}</button>
      {!comparison && <div className="timeline-meta"><span>数据口径</span><b>{metric === 'ndvi' ? '遥感年度合成' : metric === 'discharge' ? '历史模型径流' : '气候再分析'}</b></div>}
        </section> : <div className="timeline-context"><span>{sceneCaptions[scene]}</span><span>{future?'预报有效至 '+dateTime(forecastSnapshot?.validTo):'研究资料 · '+(ecology.year?ecology.year+' 年':'台账基准')+' · 非实时生态状态'}</span></div>}
      </div>
    </div>

  </main>
  {helpOpen && <div className="help-backdrop"><section ref={setHelpElement} role="dialog" aria-modal="true" aria-labelledby="help-title" className="help-dialog">
    <span className="eyebrow">从一个研究问题开始</span><h2 id="help-title">了解金沙江，先找到证据。</h2><p>选择站点或区域，核对资料时间，读取结论，再保存可复核成果。</p>
    <div className="help-tasks"><button type="button" onClick={()=>startTask('current')}><Leaf size={25}/><b>了解当前生态状况</b><span>从石鼓站 2025 年历史研究资料开始，查看 EEI 与输入依据。</span></button>
      <button type="button" onClick={()=>startTask('change')}><ChartNoAxesCombined size={25}/><b>比较两期变化</b><span>比较 2020 与 2025 的共同样本，核对固定背景与年度输入。</span></button>
      <button type="button" onClick={()=>startTask('future')}><Waves size={25}/><b>查看未来七天压力</b><span>查看有有效期的气象驱动。生态胁迫仍为待校准的研究试验。</span></button></div>
    <p className="research-notice">历史资料、模型预报和假设情景分别标注。当前未接入分钟级遥测；没有有效资料时不输出确定风险。</p>
    <button type="button" className="help-skip" onClick={closeHelp}>跳过，进入工作台</button><small>随时可从右上角“使用帮助”重新打开。</small>
  </section></div>}
  </div>
}
