import type { Metric, Scene } from './data'

export type CameraView = { lon:number; lat:number; zoom:number }
export type ViewQuery = {
  scene:Scene; station:string | null; year:number | null; metric:Metric;
  relief:boolean; rivers:boolean; border:boolean; expanded:boolean; entire:boolean;
  mapIndicator:'precipitation'|'temperature'|'forest'|'eei'; rsei:boolean; rseiYear:string;
  camera:CameraView | null
  scope:string; bbox:string; scenario:string; compareYear:string;
  analysis:'current'|'change'|'sensitivity'; forecastBatch:string; forecastDay:string; run:string
  online:boolean; flat:boolean
  rseiMask:'common'|'annual'
  workspaceView:'results'|'map'|'tools'
}

const scenes: Scene[] = ['ecology','vegetation','water','engineering','dispatch','flood','quality','emergency','warning','data','forecast','methods','results']
const metrics: Metric[] = ['ndvi','temperature','precipitation','evapotranspiration','discharge']
const indicators = ['precipitation','temperature','forest','eei'] as const
const validNumber = (value:string | null, min:number, max:number) => value !== null && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value)>=min && Number(value)<=max ? Number(value) : null

export function readViewQuery(search = window.location.search): ViewQuery {
  const q = new URLSearchParams(search)
  const lon = validNumber(q.get('lon'),-180,180), lat = validNumber(q.get('lat'),-85,85), zoom = validNumber(q.get('zoom'),0,24)
  const year = validNumber(q.get('year'),1900,2100)
  return {
    scene:scenes.find(value=>value===q.get('scene')) ?? 'ecology',
    station:q.get('station') || null, year:year !== null && Number.isInteger(year) ? year : null,
    metric:metrics.find(value=>value===q.get('metric')) ?? 'ndvi',
    relief:q.get('relief') !== '0', rivers:q.get('rivers') !== '0', border:q.get('border') === '1',
    expanded:q.get('expanded') === '1', entire:q.get('entire') === '1',
    mapIndicator:indicators.find(value=>value===q.get('indicator')) ?? 'precipitation',
    rsei:q.get('rsei') === '1', rseiYear:q.get('rseiYear') ?? '',
    camera:lon !== null && lat !== null && zoom !== null ? {lon,lat,zoom} : null,
    scope:q.get('scope') || 'basin', bbox:q.get('bbox') || '',
    scenario:['baseline','restoration','degradation','drought','wet','warming'].find(value=>value===q.get('scenario')) ?? 'baseline',
    compareYear:/^\d{4}$/.test(q.get('compareYear') ?? '') ? q.get('compareYear')! : '',
    analysis:q.get('analysis') === 'change' ? 'change' : q.get('analysis') === 'sensitivity' ? 'sensitivity' : 'current',
    forecastBatch:/^[a-f0-9]{24}$/.test(q.get('batch') ?? '') ? q.get('batch')! : '',
    forecastDay:/^\d{4}-\d{2}-\d{2}$/.test(q.get('day') ?? '') ? q.get('day')! : '',
    run:/^[a-f0-9]{64}$/.test(q.get('run') ?? '') ? q.get('run')! : '',
    online:q.get('online')!=='0',flat:q.get('flat')==='1',
    rseiMask:q.get('mask')==='annual'?'annual':'common',
    workspaceView:q.get('view')==='map'?'map':q.get('view')==='tools'?'tools':'results',
  }
}

export function writeViewQuery(view:ViewQuery, url = new URL(window.location.href)) {
  const q = url.searchParams
  q.set('scene',view.scene)
  if (view.station) q.set('station',view.station); else q.delete('station')
  q.set('year',view.year !== null ? String(view.year) : 'baseline')
  q.set('metric',view.metric)
  for (const key of ['relief','rivers','border','expanded','entire','rsei','online','flat'] as const) q.set(key,view[key]?'1':'0')
  q.set('indicator',view.mapIndicator)
  if (view.rseiYear) q.set('rseiYear',view.rseiYear); else q.delete('rseiYear')
  if (view.camera) {
    q.set('lon',view.camera.lon.toFixed(5));q.set('lat',view.camera.lat.toFixed(5));q.set('zoom',view.camera.zoom.toFixed(2))
  } else {q.delete('lon');q.delete('lat');q.delete('zoom')}
  q.set('scope',view.scope);q.set('scenario',view.scenario);q.set('analysis',view.analysis)
  q.set('mask',view.rseiMask)
  q.set('view',view.workspaceView)
  for (const [key,value] of [['bbox',view.bbox],['compareYear',view.compareYear],['batch',view.forecastBatch],['day',view.forecastDay],['run',view.run]]) {
    if (value) q.set(key,value); else q.delete(key)
  }
  return url
}
