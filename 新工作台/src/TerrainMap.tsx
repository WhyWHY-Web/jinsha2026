import { useEffect, useRef, useState } from 'react'
import { Compass, LocateFixed, Maximize, Minus, Plus } from 'lucide-react'
import { Map as MapLibreMap, Marker, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl'
import type { FeatureCollection, Point as GeoPoint } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import terrainWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { MapConfig, MapLocation, RseiLayer, Scene, Station, StationMark } from './data'
import { compactLabel } from './map-labels'
import type { CameraView } from './view-query'

setWorkerUrl(terrainWorker)

const camera = { center: [101.35, 27.93] as [number, number], zoom: 6.74, pitch: 63, bearing: 30, padding:{top:0,bottom:74,left:0,right:0} }
const cascadeCamera = { ...camera, center:[103.48,27.62] as [number,number], zoom:7.48, pitch:57, bearing:22 }
const floodCamera = { ...camera, center:[102.15,27.4] as [number,number], zoom:7.03, pitch:57, bearing:23 }
const riverColors: Partial<Record<Scene, [string, string]>> = {
  ecology:['#b2eeff','#29a9df'],
  vegetation:['#9fffd8','#19cda0'],
  water:['#b9eeff','#159bff'],
  engineering:['#b2e6ff','#4696ff'],
  dispatch:['#8ffce9','#17ceca'],
  flood:['#afdafd','#5199e8'],
  quality:['#9ee6fc','#30b8ee'],
  emergency:['#a6ccf2','#4b80cc'],
  warning:['#ffd4a9','#ed8a5c']
}

const vegetationColors = ['#bc846b','#c8ad67','#90be78','#45ad8e','#43caba']

export function TerrainMap({ config, stations, selected, scene, relief, rivers, border, expanded, onSelect, vegetation, entire, marks, metricMarks, stationIds, location,
  basinId, onBasin, rsei, focusTick, compare, initialView, onViewChange,
  online,flat,onFlatChange,drawing,bbox,onBounds }: {
  config: MapConfig, stations: Station[], selected: Station | null, scene: Scene, relief: boolean,
  rivers: boolean, border: boolean, expanded: boolean, onSelect: (station: Station) => void, vegetation?: Record<string,number>, entire: boolean,
  marks?: Record<string,StationMark>, metricMarks?: Record<string,StationMark>, stationIds?: readonly string[], location?: MapLocation | null,
  basinId?: string, onBasin?: (id:string)=>void, rsei?: RseiLayer, focusTick?:number,
  compare?: {a:Record<string,number>;b:Record<string,number>;blend:number} | null,
  initialView?:CameraView | null, onViewChange?:(view:CameraView)=>void
  online:boolean;flat:boolean;onFlatChange:(value:boolean)=>void;drawing:boolean;bbox?:string;onBounds:(value:string)=>void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const choices = useRef(onSelect)
  choices.current = onSelect
  const basinChoice = useRef(onBasin)
  basinChoice.current = onBasin
  const viewChange = useRef(onViewChange)
  viewChange.current = onViewChange
  const initialCamera = useRef(initialView)
  const skipInitialReframe = useRef(Boolean(initialView))
  const pins = useRef<Array<{ id: string; location: [number,number]; marker: Marker; element: HTMLButtonElement; reading: HTMLElement; metric:HTMLElement }>>([])
  const labelUpdate = useRef<()=>void>(()=>{})
  const priorities = useRef(metricMarks)
  priorities.current = metricMarks
  const selectedId = useRef(selected?.id)
  selectedId.current = selected?.id
  const pulseTimer = useRef<number | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [heading, setHeading] = useState(camera.bearing)
  const flatChange=useRef(onFlatChange);flatChange.current=onFlatChange
  const drawingNow=useRef(drawing);drawingNow.current=drawing
  const boundsChoice=useRef(onBounds);boundsChoice.current=onBounds
  const [zoomLevel,setZoomLevel]=useState(initialView?.zoom ?? camera.zoom)
  const [onlineFailed,setOnlineFailed]=useState(false)
  const [layerError,setLayerError]=useState('')
  const [retry,setRetry]=useState(0)
  const [fullscreen,setFullscreen] = useState(false)
  const [mapHint,setMapHint] = useState("")
  const sceneCamera = scene === 'engineering' || scene === 'dispatch' ? cascadeCamera : scene === 'flood' ? floodCamera : camera

  useEffect(() => {
    if (!ref.current) return
    setStatus('loading');setOnlineFailed(false);setLayerError('')
    const [west,south,east,north] = config.bounds
    const contextImage = config.context && {
      type:'image' as const, url:config.context.url,
      coordinates: [
        [config.context.bounds[0],config.context.bounds[3]],
        [config.context.bounds[2],config.context.bounds[3]],
        [config.context.bounds[2],config.context.bounds[1]],
        [config.context.bounds[0],config.context.bounds[1]]
      ] as [[number,number],[number,number],[number,number],[number,number]]
    }
    const style: StyleSpecification = {
      version: 8,
      sources: {
        dem: { type:'raster-dem', tiles:[config.terrainUrl], tileSize:256, minzoom:5, maxzoom:config.terrainMaxZoom ?? 9, encoding:'terrarium', bounds:config.bounds },
        'dem-shade': { type:'raster-dem', tiles:[config.terrainUrl], tileSize:256, minzoom:5, maxzoom:config.terrainMaxZoom ?? 9, encoding:'terrarium', bounds:config.bounds },
        ...(config.regionalTerrain ? { regional: { type:'raster-dem' as const, tiles:[config.regionalTerrain.url], tileSize:256,
          minzoom:5, maxzoom:7, encoding:'terrarium' as const, bounds:config.regionalTerrain.bounds } } : {}),
        satellite: { type:'image', url:config.fallbackImageUrl, coordinates:[[west,north],[east,north],[east,south],[west,south]] },
        ...(config.onlineImagery ? {'detail-imagery':{type:'raster' as const,tiles:[config.onlineImagery.url],tileSize:256,minzoom:7,maxzoom:config.onlineImagery.maxZoom}} : {}),
        ...(contextImage ? { context:contextImage } : {}),
        rivers: { type:'geojson', data:config.riverUrl },
        basin: { type:'geojson', data:config.basinUrl }
      },
      layers: [
        { id:'sky-floor', type:'background', paint:{'background-color':'#09172a'} },
        ...(contextImage ? [{ id:'context-relief', type:'raster' as const, source:'context', paint:{'raster-opacity':.88} }] : []),
        { id:'relief', type:'hillshade', source:'dem-shade', paint:{
          'hillshade-shadow-color':'#16242b','hillshade-highlight-color':'#c8cfd0',
          'hillshade-accent-color':'#45545a','hillshade-exaggeration':.22,'hillshade-illumination-direction':321
        }},
        { id:'satellite', type:'raster', source:'satellite', paint:{
          'raster-opacity':1,'raster-brightness-min':0,'raster-brightness-max':1,
          'raster-saturation':0,'raster-contrast':0,'raster-fade-duration':170
        }},
        ...(config.onlineImagery ? [{id:'detail-imagery',type:'raster' as const,source:'detail-imagery',layout:{visibility:'none' as const},paint:{'raster-opacity':1,'raster-fade-duration':250}}] : []),
        { id:'basin-tint', type:'fill', source:'basin', paint:{'fill-color':'#1599d9','fill-opacity':.045} },
        { id:'boundaries', type:'line', source:'basin', paint:{'line-color':'#67a6c7','line-width':.8,'line-opacity':.31,'line-dasharray':[3,2]} },
        { id:'basin-selected', type:'line', source:'basin', layout:{visibility:'none'}, paint:{
          'line-color':'#a4efdf','line-width':2.6,'line-opacity':.92,'line-blur':.35
        }},
        { id:'river-background', type:'line', source:'rivers', layout:{'line-cap':'round','line-join':'round'},
          paint:{'line-color':'#41bfff','line-width':['case',['==',['get','role'],'main'],6,1],'line-blur':2,'line-opacity':.12} },
        { id:'river-glow', type:'line', source:'rivers', filter:['==',['get','role'],'main'],
          layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#1ba5ff','line-width':3,'line-blur':1,'line-opacity':.24} },
        { id:'river-flow', type:'line', source:'rivers', filter:['==',['get','role'],'main'],
          paint:{'line-color':'#b5f1ff','line-width':1.2,'line-blur':0,'line-opacity':.35,'line-dasharray':[1,5]} },
        { id:'river-core', type:'line', source:'rivers', layout:{'line-cap':'round','line-join':'round'},paint:{
          'line-color':['case',['==',['get','role'],'main'],'#96e5ff','#4aa9cc'],
          'line-opacity':['case',['==',['get','role'],'main'],.95,.68],
          'line-width':['case',['==',['get','role'],'main'],2.6,.85]
        }}
      ],
      sky: {
        'sky-color':'#0b2546','sky-horizon-blend':.40,'horizon-color':'#254263',
        'horizon-fog-blend':.32,'fog-color':'#132d49','fog-ground-blend':.20
      }
    }
    let instance: MapLibreMap
    try {
      instance = new MapLibreMap({
        container:ref.current, style, ...camera,
        ...(initialCamera.current ? {center:[initialCamera.current.lon,initialCamera.current.lat] as [number,number],zoom:initialCamera.current.zoom} : {}),
        canvasContextAttributes:{preserveDrawingBuffer:true}, maxPitch:75, minZoom:4, maxZoom:16,
        renderWorldCopies:false, attributionControl:false, dragRotate:true, fadeDuration:100
      })
    } catch {
      setStatus('error')
      return
    }
    map.current = instance
    instance.on('error',event=>{
      const sourceId=(event as typeof event & {sourceId?:string}).sourceId
      const message=String(event.error?.message ?? '')
      if(sourceId==='detail-imagery' || message.includes('tiles.maps.eox.at')) {
        setOnlineFailed(true);setLayerError('在线影像加载失败，已回退区域预览。')
        if(instance.getLayer('detail-imagery'))instance.setLayoutProperty('detail-imagery','visibility','none')
      } else if(sourceId==='dem' || sourceId==='regional' || /\/(?:terrain|regional-dem)\//.test(message)) {
        setLayerError('部分地形缺失，已回退二维地图。');flatChange.current(true);instance.setTerrain(null)
      } else {setLayerError('部分地图资料未能加载，请检查网络或重试图层。')}
    })
    let loaded = false
    instance.on('load', () => {
      loaded = true
      setStatus('ready')
      const center = instance.getCenter()
      viewChange.current?.({lon:center.lng,lat:center.lat,zoom:instance.getZoom()})
      for (const station of stations) {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'map-pin'
        element.dataset.station = station.id
        element.dataset.stationName = station.name
        element.setAttribute('aria-label', '地图定位 ' + station.name)
        const dot = document.createElement('span')
        dot.className = 'pin-shape'
        const label = document.createElement('span')
        label.className = 'pin-label'
        const name = document.createElement('strong')
        name.textContent = station.name
        label.append(name)
        const reading = document.createElement('small')
        reading.dataset.fallback = station.elevation == null ? '' : '高程 ' + Math.round(station.elevation) + ' m'
        label.append(reading)
        const metric = document.createElement('small')
        metric.className = 'pin-metric'
        label.append(metric)
        const glyph = document.createElement('i')
        glyph.textContent = station.type.includes('电站') ? '▥' : '≈'
        glyph.setAttribute('aria-hidden','true')
        dot.append(glyph)
        element.append(dot,label)
        element.onclick = () => {if(!drawingNow.current)choices.current(station)}
        if (station.type.includes('电站')) element.classList.add('pin-dam')
        const marker = new Marker({ element, anchor:'bottom' }).setLngLat([station.lon,station.lat]).addTo(instance)
        pins.current.push({ id:station.id, location:[station.lon,station.lat], marker, element, reading, metric })
      }
    })
    instance.on('click','basin-tint',event=>{
      const id = event.features?.[0]?.properties?.HYBAS_ID
      if (!drawingNow.current && id !== undefined && id !== null) basinChoice.current?.(String(id))
    })
    instance.on('mouseenter','basin-tint',()=>{
      if (basinChoice.current) instance.getCanvas().style.cursor = 'pointer'
    })
    instance.on('mouseleave','basin-tint',()=>{ instance.getCanvas().style.cursor = '' })
    const updateLabels = () => {
      const used: Array<{x:number;y:number}> = []
      const ranked = [...pins.current].filter(pin=>!pin.element.hidden).sort((a,b)=>
        Number(b.id===selectedId.current)-Number(a.id===selectedId.current) ||
        (priorities.current?.[b.id]?.priority ?? 0)-(priorities.current?.[a.id]?.priority ?? 0))
      for (const [index,pin] of ranked.entries()) {
        if (pin.element.hidden) continue
        const point = instance.project(pin.location)
        const overlaps = used.some(position => Math.abs(position.x-point.x)<112 && Math.abs(position.y-point.y)<43)
        const lowZoom = instance.getZoom()<6.1
        const compact = compactLabel(instance.getZoom(),index,overlaps,pin.id===selectedId.current)
        pin.element.classList.toggle('pin-lowzoom',lowZoom)
        pin.element.classList.toggle('pin-compact',compact)
        if (!compact) used.push(point)
      }
    }
    labelUpdate.current = updateLabels
    instance.on('moveend', updateLabels)
    instance.on('moveend', () => {
      const center = instance.getCenter()
      setZoomLevel(instance.getZoom())
      viewChange.current?.({lon:center.lng,lat:center.lat,zoom:instance.getZoom()})
    })
    instance.on('rotate', () => setHeading(instance.getBearing()))
    const resize = new ResizeObserver(() => instance.resize())
    resize.observe(ref.current)
    return () => {
      window.clearTimeout(pulseTimer.current)
      resize.disconnect()
      for (const pin of pins.current) pin.marker.remove()
      pins.current = []
      instance.remove()
      map.current = null
    }
  },[config, stations,retry])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    const update=()=>{
      const center=instance.getCenter(),[west,south,east,north]=config.bounds
      const fine=center.lng>=west && center.lng<=east && center.lat>=south && center.lat<=north && instance.getZoom()>=6.5
      const source=(!entire || fine || !config.regionalTerrain)?'dem':'regional'
      const terrain=instance.getTerrain()
      if(flat){if(terrain)instance.setTerrain(null)}
      else if(terrain?.source!==source || terrain.exaggeration!==1)instance.setTerrain({source,exaggeration:1})
    }
    update();instance.on('moveend',update)
    return ()=>{instance.off('moveend',update)}
  },[status,flat,entire,config])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange',onChange)
    return () => document.removeEventListener('fullscreenchange',onChange)
  },[])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    instance.setPaintProperty('satellite','raster-opacity', relief ? .96 : 0)
    instance.setPaintProperty('relief','hillshade-exaggeration',relief ? .1 : .35)
    if(instance.getLayer('detail-imagery'))instance.setLayoutProperty('detail-imagery','visibility',relief && online && !onlineFailed?'visible':'none')
    for (const layer of ['river-background','river-glow','river-core','river-flow']) {
      instance.setLayoutProperty(layer,'visibility',rivers?'visible':'none')
    }
    const showBasins = border || scene === 'ecology'
    for (const layer of ['basin-tint','boundaries']) instance.setLayoutProperty(layer,'visibility',showBasins?'visible':'none')
    if (expanded && !instance.getSource('expanded') && config.expandedRiverUrl) {
      instance.addSource('expanded', { type:'geojson', data:config.expandedRiverUrl, tolerance:1 })
      instance.addLayer({
        id:'expanded-network', type:'line', source:'expanded',
        paint:{'line-color':'#4eacd0','line-opacity':.56,'line-width':['interpolate',['linear'],['zoom'],5,.42,9,1.45]}
      },'river-background')
    }
    if (instance.getLayer('expanded-network')) instance.setLayoutProperty('expanded-network','visibility',expanded?'visible':'none')
    const [core,glow] = riverColors[scene] ?? ['#a5ebff','#1ba5ff']
    instance.setPaintProperty('river-core','line-color',['case',['==',['get','role'],'main'],core,'#4aa9cc'])
    instance.setPaintProperty('river-glow','line-color',glow)
    instance.setPaintProperty('river-flow','line-color',core)
  },[status, scene, relief, rivers, border, expanded, config.expandedRiverUrl,online,onlineFailed])

  useEffect(()=>{
    const instance=map.current
    if(!instance || status!=='ready')return
    if(!instance.getSource('analysis-bounds')) {
      instance.addSource('analysis-bounds',{type:'geojson',data:{type:'FeatureCollection',features:[]}})
      instance.addLayer({id:'analysis-bounds-fill',type:'fill',source:'analysis-bounds',paint:{'fill-color':'#87e7bd','fill-opacity':.12}})
      instance.addLayer({id:'analysis-bounds-line',type:'line',source:'analysis-bounds',paint:{'line-color':'#b2ffda','line-width':2,'line-dasharray':[3,2]}})
    }
    const set=(values:number[])=>{
      const [w,s,e,n]=values
      ;(instance.getSource('analysis-bounds') as GeoJSONSource).setData({type:'FeatureCollection',features:values.length===4 && values.every(Number.isFinite) && w<e && s<n ? [{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}}]:[]})
    }
    set(bbox?.split(',').map(Number) ?? [])
    if(!drawing)return
    const drag=instance.dragPan.isEnabled();instance.dragPan.disable();instance.getCanvas().style.cursor='crosshair'
    let start:[number,number]|null=null
    const down=(event:{lngLat:{lng:number;lat:number};originalEvent:MouseEvent})=>{if(event.originalEvent.button===0)start=[event.lngLat.lng,event.lngLat.lat]}
    const bounds=(end:{lng:number;lat:number})=>start?[Math.min(start[0],end.lng),Math.min(start[1],end.lat),Math.max(start[0],end.lng),Math.max(start[1],end.lat)]:[]
    const move=(event:{lngLat:{lng:number;lat:number}})=>{if(start)set(bounds(event.lngLat))}
    const up=(event:{lngLat:{lng:number;lat:number}})=>{
      if(!start)return
      const values=bounds(event.lngLat);start=null
      if(values[2]-values[0]>.001 && values[3]-values[1]>.001)boundsChoice.current(values.map(n=>n.toFixed(5)).join(','))
    }
    instance.on('mousedown',down);instance.on('mousemove',move);instance.on('mouseup',up)
    return ()=>{instance.off('mousedown',down);instance.off('mousemove',move);instance.off('mouseup',up);if(drag)instance.dragPan.enable();instance.getCanvas().style.cursor=''}
  },[status,bbox,drawing])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    const asColor = (value: number | null) => value == null ? '#647f90' : vegetationColors[Math.min(4,Math.floor(Math.max(0,value)*5))]
    const color: ExpressionSpecification | string = rsei && Object.keys(rsei.values).length > 0
      ? ['match',['to-string',['get','HYBAS_ID']], ...Object.entries(rsei.values).flatMap(([id,value])=>[id,asColor(value)]),'#647f90'] as ExpressionSpecification
      : '#1599d9'
    instance.setPaintProperty('basin-tint','fill-color',color)
    instance.setPaintProperty('basin-tint','fill-opacity',rsei ? .39 : .045)
    instance.setLayoutProperty('basin-selected','visibility',basinId?'visible':'none')
    if (basinId) instance.setFilter('basin-selected',['==',['to-string',['get','HYBAS_ID']],basinId])
  },[status,basinId,rsei])

  useEffect(() => {
    if (status !== 'ready') return
    for (const pin of pins.current) {
      const active = selected?.id === pin.id
      pin.element.classList.toggle('pin-active', active)
      pin.element.setAttribute('aria-pressed',String(active))
      if (active && focusTick) {
        pin.element.classList.remove('pin-pulse')
        void pin.element.offsetWidth
        pin.element.classList.add('pin-pulse')
        window.clearTimeout(pulseTimer.current)
        pulseTimer.current = window.setTimeout(()=>pin.element.classList.remove('pin-pulse'),1400)
      }
    }
    if (selected && (focusTick ?? 0) > 0 && !location && map.current) {
      map.current.flyTo({ center:[selected.lon,selected.lat], zoom:8.1, pitch:flat?0:55, padding:{top:0,bottom:10,left:0,right:0}, duration:1050 })
    }
    labelUpdate.current()
  },[selected,status,location,flat,focusTick])

  useEffect(() => {
    if (status !== 'ready') return
    for (const pin of pins.current) {
      const mark = marks?.[pin.id]
      const metric = metricMarks?.[pin.id]
      const ndvi = vegetation?.[pin.id]
      let color = mark?.color
      if (vegetation) {
        const hue = 31 + Math.min(1,Math.max(0,((ndvi ?? 0)-.18)/.62))*131
        color = ndvi === undefined ? '#8392a0' : 'hsl('+hue+' 82% 62%)'
      }
      if (color) pin.element.style.setProperty('--pin',color)
      else pin.element.style.removeProperty('--pin')
      pin.element.style.setProperty('--status',metric?.color ?? '#8295a6')
      pin.reading.textContent = mark?.reading ?? (ndvi === undefined ? metric?.reading ?? '' : 'NDVI '+ndvi.toFixed(3))
      pin.reading.hidden = !pin.reading.textContent
      pin.metric.textContent = (mark?.reading || ndvi !== undefined) ? metric?.reading ?? '' : ''
      pin.metric.hidden = !pin.metric.textContent
      pin.element.setAttribute('aria-label','地图定位 '+pin.element.dataset.stationName+'，'+[pin.reading.textContent,pin.metric.textContent].filter(Boolean).join('，'))
      pin.element.hidden = stationIds !== undefined && !stationIds.includes(pin.id)
    }
    labelUpdate.current()
  },[vegetation,marks,metricMarks,stationIds,status])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    const collection = (values:Record<string,number>):FeatureCollection<GeoPoint> => ({type:'FeatureCollection',features:stations.flatMap(station => {
      const value=values[station.id]
      return Number.isFinite(value) ? [{type:'Feature' as const,properties:{color:vegetationColors[Math.min(4,Math.floor(Math.max(0,value)*5))]},
        geometry:{type:'Point' as const,coordinates:[station.lon,station.lat]}}] : []
    })})
    for (const [key,values,opacity] of [['a',compare?.a,compare ? 1-compare.blend : 0],['b',compare?.b,compare?.blend ?? 0]] as const) {
      const source='comparison-'+key
      if (!instance.getSource(source)) {
        instance.addSource(source,{type:'geojson',data:{type:'FeatureCollection',features:[]}})
        instance.addLayer({id:source,type:'circle',source,paint:{'circle-radius':16,'circle-color':['get','color'],
          'circle-opacity':0,'circle-blur':.3,'circle-stroke-width':1,'circle-stroke-color':'#e4faff',
          'circle-stroke-opacity':0,'circle-opacity-transition':{duration:300},'circle-stroke-opacity-transition':{duration:300}}})
      }
      ;(instance.getSource(source) as GeoJSONSource).setData(collection(values ?? {}))
      instance.setPaintProperty(source,'circle-opacity',opacity*.72)
      instance.setPaintProperty(source,'circle-stroke-opacity',opacity*.9)
    }
  },[status,stations,compare])

  useEffect(() => {
    if (status !== 'ready' || !map.current || selected || location) return
    if (skipInitialReframe.current) { skipInitialReframe.current = false; return }
    if (entire && config.expandedRiverBounds) {
      const horizontal = Math.min(185,Math.floor((ref.current?.clientWidth ?? 850)/4))
      map.current.fitBounds(config.expandedRiverBounds, { padding:{left:horizontal,right:horizontal,top:35,bottom:35}, bearing:0,
        pitch:flat || !config.regionalTerrain ? 0 : 35, duration:1050 })
    } else {
      map.current.easeTo({ ...sceneCamera, pitch:flat?0:sceneCamera.pitch, duration:750 })
    }
  },[entire, status, config.expandedRiverBounds, config.regionalTerrain, selected, location, sceneCamera,flat])

  useEffect(() => {
    const instance = map.current
    if (status !== 'ready' || !instance || !location) return
    const marker = document.createElement('div')
    marker.className = 'external-pin'
    marker.textContent = location.name
    const position: [number,number] = [location.lon,location.lat]
    const pin = new Marker({ element:marker, anchor:'bottom' }).setLngLat(position).addTo(instance)
    instance.easeTo({ center:position, zoom:8.1, pitch:flat?0:50, duration:850, padding:{top:0,bottom:30,left:0,right:0} })
    return () => { pin.remove() }
  },[location,status,flat])

  const reframe = () => map.current?.easeTo({ ...sceneCamera, pitch:flat?0:sceneCamera.pitch,duration:950 })
  function toggleFullscreen() {
    const root = ref.current?.closest('main')
    if (!root?.requestFullscreen) {
      setMapHint('浏览器未开放全屏控制')
      return
    }
    const change = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()
    void change.then(()=>setMapHint("")).catch(()=>setMapHint('当前窗口无法切换全屏'))
  }
  return <div className="map-surface" data-map-status={status}>
    <div ref={ref} className="terrain" aria-label="金沙江数字高程三维地图"/>
    {status !== 'ready' && <div className="map-status" role="status">{status === 'loading' ? '正在读取地形与河网' : '三维地图暂不可用'}</div>}
    <div className="map-tools" aria-label="地图控制">
      <button type="button" onClick={() => map.current?.setBearing(0)} aria-label="恢复北向"><Compass size={19} style={{transform:'rotate('+(-heading)+'deg)'}}/></button>
      <button type="button" onClick={reframe} aria-label="复位地图"><LocateFixed size={17}/></button>
      <button type="button" onClick={() => map.current?.zoomIn()} aria-label="放大地图"><Plus size={17}/></button>
      <button type="button" onClick={() => map.current?.zoomOut()} aria-label="缩小地图"><Minus size={17}/></button>
      <button type="button" onClick={()=>onFlatChange(!flat)} aria-label={flat?'切换三维地形':'切换二维地图'}>{flat?'3D':'2D'}</button>
      <button type="button" onClick={toggleFullscreen} aria-label={fullscreen?'退出全屏':'全屏工作台'}><Maximize size={16}/></button>
      {mapHint && <small role="status" className="map-control-hint">{mapHint}</small>}
    </div>
    <div className="map-source-note"><b>{online && !onlineFailed && zoomLevel>=7?'EOX 多级影像 · 2024 年合成':'区域影像预览 · 采集日期未提供'}</b>
      <span>{online && !onlineFailed && zoomLevel>=7?`源采样 10 m · 请求层级 ≤${Math.min(14,Math.floor(zoomLevel))}；${zoomLevel>14?'已达源层级上限':'非实时实景'}`:'预览约 180–370 m/像素，放大不会增加真实细节'}</span>
      {online && !onlineFailed && config.onlineImagery && <a href="https://cloudless.eox.at/documentation/license" target="_blank" rel="noreferrer">EOxCloudless by EOX · Contains modified Copernicus Sentinel data 2024 · CC BY-NC-SA 4.0</a>}
      {layerError && <span role="status">{layerError}<button type="button" onClick={()=>{const center=map.current?.getCenter();if(center && map.current)initialCamera.current={lon:center.lng,lat:center.lat,zoom:map.current.getZoom()};setRetry(v=>v+1)}}>重试图层</button></span>}
    </div>
  </div>
}
