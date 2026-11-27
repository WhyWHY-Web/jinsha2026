import { useEffect, useRef, useState } from 'react'
import { Compass, LocateFixed, Maximize, Minus, Plus } from 'lucide-react'
import { Map as MapLibreMap, Marker, setWorkerUrl, type ExpressionSpecification, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import terrainWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { MapConfig, MapLocation, RseiLayer, Scene, Station, StationMark } from './data'

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
  emergency:['#a6ccf2','#4b80cc']
}

const vegetationColors = ['#bc846b','#c8ad67','#90be78','#45ad8e','#43caba']

export function TerrainMap({ config, stations, selected, scene, relief, rivers, border, expanded, onSelect, vegetation, entire, marks, stationIds, location,
  basinId, onBasin, rsei }: {
  config: MapConfig, stations: Station[], selected: Station | null, scene: Scene, relief: boolean,
  rivers: boolean, border: boolean, expanded: boolean, onSelect: (station: Station) => void, vegetation?: Record<string,number>, entire: boolean,
  marks?: Record<string,StationMark>, stationIds?: readonly string[], location?: MapLocation | null,
  basinId?: string, onBasin?: (id:string)=>void, rsei?: RseiLayer
}) {
  const ref = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const choices = useRef(onSelect)
  choices.current = onSelect
  const basinChoice = useRef(onBasin)
  basinChoice.current = onBasin
  const pins = useRef<Array<{ id: string; location: [number,number]; marker: Marker; element: HTMLButtonElement; reading: HTMLElement }>>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [heading, setHeading] = useState(camera.bearing)
  const [flat, setFlat] = useState(false)
  const [fullscreen,setFullscreen] = useState(false)
  const [mapHint,setMapHint] = useState("")
  const sceneCamera = scene === 'engineering' || scene === 'dispatch' ? cascadeCamera : scene === 'flood' ? floodCamera : camera

  useEffect(() => {
    if (!ref.current) return
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
        ...(config.regionalTerrain ? { regional: { type:'raster-dem' as const, tiles:[config.regionalTerrain.url], tileSize:256,
          minzoom:5, maxzoom:7, encoding:'terrarium' as const, bounds:config.regionalTerrain.bounds } } : {}),
        satellite: { type:'image', url:config.fallbackImageUrl, coordinates:[[west,north],[east,north],[east,south],[west,south]] },
        ...(contextImage ? { context:contextImage } : {}),
        rivers: { type:'geojson', data:config.riverUrl },
        basin: { type:'geojson', data:config.basinUrl }
      },
      layers: [
        { id:'sky-floor', type:'background', paint:{'background-color':'#09172a'} },
        ...(contextImage ? [{ id:'context-relief', type:'raster' as const, source:'context', paint:{'raster-opacity':.88} }] : []),
        { id:'relief', type:'hillshade', source:'dem', paint:{
          'hillshade-shadow-color':'#081426','hillshade-highlight-color':'#6587a5',
          'hillshade-accent-color':'#193451','hillshade-exaggeration':.52,'hillshade-illumination-direction':321
        }},
        { id:'satellite', type:'raster', source:'satellite', paint:{
          'raster-opacity':.96,'raster-brightness-min':.045,'raster-brightness-max':.78,
          'raster-saturation':-.45,'raster-contrast':.21,'raster-fade-duration':170
        }},
        { id:'basin-tint', type:'fill', source:'basin', paint:{'fill-color':'#1599d9','fill-opacity':.045} },
        { id:'boundaries', type:'line', source:'basin', paint:{'line-color':'#67a6c7','line-width':.8,'line-opacity':.31,'line-dasharray':[3,2]} },
        { id:'basin-selected', type:'line', source:'basin', layout:{visibility:'none'}, paint:{
          'line-color':'#a4efdf','line-width':2.6,'line-opacity':.92,'line-blur':.35
        }},
        { id:'river-background', type:'line', source:'rivers', layout:{'line-cap':'round','line-join':'round'},
          paint:{'line-color':'#41bfff','line-width':['case',['==',['get','role'],'main'],17,3],'line-blur':7,'line-opacity':.36} },
        { id:'river-glow', type:'line', source:'rivers', filter:['==',['get','role'],'main'],
          layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#1ba5ff','line-width':7.5,'line-blur':3.5,'line-opacity':.82} },
        { id:'river-flow', type:'line', source:'rivers', filter:['==',['get','role'],'main'],
          paint:{'line-color':'#b5f1ff','line-width':3.2,'line-blur':.7,'line-opacity':.9,'line-dasharray':[1,5]} },
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
        container:ref.current, style, ...camera, maxPitch:75, minZoom:4, maxZoom:13,
        renderWorldCopies:false, attributionControl:false, dragRotate:true, fadeDuration:100
      })
    } catch {
      setStatus('error')
      return
    }
    map.current = instance
    let loaded = false
    instance.on('load', () => {
      loaded = true
      setStatus('ready')
      for (const station of stations) {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'map-pin'
        element.dataset.station = station.id
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
        const glyph = document.createElement('i')
        glyph.textContent = station.type.includes('电站') ? '▥' : '≈'
        glyph.setAttribute('aria-hidden','true')
        dot.append(glyph)
        element.append(dot,label)
        element.onclick = () => choices.current(station)
        if (station.type.includes('电站')) element.classList.add('pin-dam')
        const marker = new Marker({ element, anchor:'bottom' }).setLngLat([station.lon,station.lat]).addTo(instance)
        pins.current.push({ id:station.id, location:[station.lon,station.lat], marker, element, reading })
      }
    })
    instance.on('click','basin-tint',event=>{
      const id = event.features?.[0]?.properties?.HYBAS_ID
      if (id !== undefined && id !== null) basinChoice.current?.(String(id))
    })
    instance.on('mouseenter','basin-tint',()=>{
      if (basinChoice.current) instance.getCanvas().style.cursor = 'pointer'
    })
    instance.on('mouseleave','basin-tint',()=>{ instance.getCanvas().style.cursor = '' })
    const updateLabels = () => {
      const used: Array<{x:number;y:number}> = []
      for (const pin of pins.current) {
        if (pin.element.hidden) continue
        const point = instance.project(pin.location)
        const overlaps = used.some(position => Math.abs(position.x-point.x)<112 && Math.abs(position.y-point.y)<43)
        pin.element.classList.toggle('pin-compact',overlaps)
        if (!overlaps) used.push(point)
      }
    }
    instance.on('moveend', updateLabels)
    instance.on('rotate', () => setHeading(instance.getBearing()))
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let pulse = 0
    const timer = reducedMotion ? undefined : window.setInterval(() => {
      if (!loaded || !instance.getLayer('river-flow')) return
      pulse = (pulse+1)%7
      instance.setPaintProperty('river-flow','line-dasharray',[pulse*.56,5,1,5-pulse*.56])
    },160)
    const resize = new ResizeObserver(() => instance.resize())
    resize.observe(ref.current)
    return () => {
      window.clearInterval(timer)
      resize.disconnect()
      for (const pin of pins.current) pin.marker.remove()
      pins.current = []
      instance.remove()
      map.current = null
    }
  },[config, stations])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    instance.setTerrain(flat ? null : { source:entire && config.regionalTerrain ? 'regional' : 'dem',
      exaggeration:entire && config.regionalTerrain ? 1.25 : 1.8 })
  },[status,flat,entire,config.regionalTerrain])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange',onChange)
    return () => document.removeEventListener('fullscreenchange',onChange)
  },[])

  useEffect(() => {
    const instance = map.current
    if (!instance || status !== 'ready') return
    instance.setPaintProperty('satellite','raster-opacity', relief ? .96 : 0)
    instance.setPaintProperty('relief','hillshade-exaggeration',relief ? 0 : .43)
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
  },[status, scene, relief, rivers, border, expanded, config.expandedRiverUrl])

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
    }
    if (selected && !location && map.current) {
      map.current.easeTo({ center:[selected.lon,selected.lat], zoom:7.85, pitch:flat?0:55, padding:{top:0,bottom:10,left:0,right:0}, duration:1050 })
    }
  },[selected,status,location,flat])

  useEffect(() => {
    if (status !== 'ready') return
    for (const pin of pins.current) {
      const mark = marks?.[pin.id]
      const ndvi = vegetation?.[pin.id]
      let color = mark?.color
      if (vegetation) {
        const hue = 31 + Math.min(1,Math.max(0,((ndvi ?? 0)-.18)/.62))*131
        color = ndvi === undefined ? '#8392a0' : 'hsl('+hue+' 82% 62%)'
      }
      if (color) pin.element.style.setProperty('--pin',color)
      else pin.element.style.removeProperty('--pin')
      pin.reading.textContent = mark?.reading ?? (ndvi === undefined ? pin.reading.dataset.fallback ?? '' : 'NDVI '+ndvi.toFixed(3))
      pin.reading.hidden = !pin.reading.textContent
      pin.element.hidden = stationIds !== undefined && !stationIds.includes(pin.id)
    }
  },[vegetation,marks,stationIds,status])

  useEffect(() => {
    if (status !== 'ready' || !map.current || selected || location) return
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
  return <div className="map-surface">
    <div ref={ref} className="terrain" aria-label="金沙江数字高程三维地图"/>
    {status !== 'ready' && <div className="map-status" role="status">{status === 'loading' ? '正在读取地形与河网' : '三维地图暂不可用'}</div>}
    <div className="map-tools" aria-label="地图控制">
      <button type="button" onClick={() => map.current?.setBearing(0)} aria-label="恢复北向"><Compass size={19} style={{transform:'rotate('+(-heading)+'deg)'}}/></button>
      <button type="button" onClick={reframe} aria-label="复位地图"><LocateFixed size={17}/></button>
      <button type="button" onClick={() => map.current?.zoomIn()} aria-label="放大地图"><Plus size={17}/></button>
      <button type="button" onClick={() => map.current?.zoomOut()} aria-label="缩小地图"><Minus size={17}/></button>
      <button type="button" onClick={()=>setFlat(!flat)} aria-label={flat?'切换三维地形':'切换二维地图'}>{flat?'3D':'2D'}</button>
      <button type="button" onClick={toggleFullscreen} aria-label={fullscreen?'退出全屏':'全屏工作台'}><Maximize size={16}/></button>
      {mapHint && <small role="status" className="map-control-hint">{mapHint}</small>}
    </div>
  </div>
}
