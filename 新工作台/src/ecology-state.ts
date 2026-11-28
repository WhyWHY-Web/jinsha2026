import { useEffect, useState } from 'react'
import type { StationMark } from './data'
import type { AssessmentReport, EcologyOptions } from './ecology-types'
import type { ViewQuery } from './view-query'

function valueText(value: unknown, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits:digits }).format(value)
    : '—'
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json() as T & { error?: unknown }
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : '服务暂不可用（'+response.status+'）')
  return payload
}

function useEcologyRequest<T>(url: string | null, version = 0) {
  const [result,setResult] = useState<{ url:string; version:number; data:T | null; error:string }>({ url:'', version:0, data:null, error:'' })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    getJson<T>(url, { signal:controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ url, version, data, error:'' }) })
      .catch(error => { if (!controller.signal.aborted) setResult({ url, version, data:null, error:String(error?.message ?? error) }) })
    return () => controller.abort()
  }, [url, version])
  const current = result.url === url && result.version === version
  return { data:current ? result.data : null, error:current ? result.error : '', loading:Boolean(url) && !current }
}

export function useEcology(active: boolean, selectedStationId?: string | null, initial?:ViewQuery) {
  const [scope,setScope] = useState(initial?.scope ?? 'basin')
  const [year,setYear] = useState(initial?.year != null ? String(initial.year) : new URLSearchParams(window.location.search).has('year') ? '' : '2025')
  const [scenario,setScenario] = useState(initial?.scenario ?? 'baseline')
  const [compareYear,setCompareYear] = useState(initial?.compareYear ?? '')
  const [bbox,setBbox] = useState(initial?.bbox ?? '')
  const [rseiLayer,setRseiLayer] = useState(false)
  const [rseiYear,setRseiYear] = useState('')
  const [rseiMask,setRseiMask]=useState(initial?.rseiMask ?? 'common')
  const [revision,setRevision] = useState(0)
  const options = useEcologyRequest<EcologyOptions>(active ? '/api/ecology/options' : null, revision)
  const activeScope = selectedStationId ? 'station:'+selectedStationId : scope
  const query = new URLSearchParams({ scope:activeScope, scenario })
  if (year) query.set('year',year)
  if (compareYear) query.set('compareYear',compareYear)
  if (activeScope === 'bbox' && bbox.trim()) query.set('bbox',bbox.trim())
  const hasBounds = activeScope !== 'bbox' || /^(\s*-?\d+(\.\d+)?\s*,){3}\s*-?\d+(\.\d+)?\s*$/.test(bbox)
  const assess = useEcologyRequest<AssessmentReport>(active && hasBounds ? '/api/ecology/assess?'+query : null, revision)
  return {
    options:options.data, report:assess.data, loading:options.loading || assess.loading,
    error:assess.error || options.error, scope, activeScope, year, scenario, compareYear, bbox, rseiLayer, rseiYear,
    setScope, setYear, setScenario, setCompareYear, setBbox, selectedStationId,
    setRseiLayer, setRseiYear,rseiMask,setRseiMask,
    refresh:() => setRevision(current => current + 1),
  }
}

export function ecologyMarks(report: AssessmentReport | null): Record<string, StationMark> | undefined {
  if (!report) return
  return Object.fromEntries(report.stations.map(station => {
    const color = /high|高/i.test(station.riskLevel) ? '#f3a67d' : /medium|moderate|中/i.test(station.riskLevel) ? '#dfca84' : '#75e2b3'
    return [station.id, { reading:'EEI '+valueText(station.metrics.eei), color }]
  }))
}
