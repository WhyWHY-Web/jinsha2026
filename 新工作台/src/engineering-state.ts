import { useEffect, useState } from 'react'
import type { DispatchKind, EngineeringCatalog } from '../data/engineering/types'
import type { Station, StationMark } from './data'
type OperationsScene = 'engineering' | 'dispatch'

const capacities = new Intl.NumberFormat('zh-CN')
const projectColors = ['#58c3ff','#4de1c2','#7498fd','#bea4fb']
const kindColors: Record<DispatchKind,string> = {
  生态试验:'#5edacb',
  管理文件:'#82b5ff',
  试验总结:'#e5b36e',
}

export function useEngineering(enabled: boolean) {
  const [data,setData] = useState<EngineeringCatalog | null>(null)
  const [error,setError] = useState(false)
  useEffect(() => {
    if (!enabled || data) return
    const controller = new AbortController()
    setError(false)
    async function load() {
      try {
        const response = await fetch('/api/engineering',{signal:controller.signal})
        if (!response.ok) throw new Error(String(response.status))
        const catalog = await response.json() as EngineeringCatalog
        if (!controller.signal.aborted) setData(catalog)
      } catch {
        if (!controller.signal.aborted) setError(true)
      }
    }
    void load()
    return () => controller.abort()
  },[enabled,data])
  return {data,error}
}

export function operationalStations(catalog: EngineeringCatalog | null, stations: Station[]) {
  return catalog?.projects.flatMap(project => {
    const station = stations.find(item=>item.id===project.id)
    return station ? [station] : []
  }) ?? []
}

function currentEvent(catalog: EngineeringCatalog, id?: string | null) {
  return catalog.dispatch.find(event=>event.id===id) ?? catalog.dispatch[0]
}

export function operationMarks(catalog: EngineeringCatalog | null, scene: OperationsScene, dispatchEventId?: string | null) {
  const marks: Record<string,StationMark> = {}
  if (!catalog) return marks
  const event = currentEvent(catalog,dispatchEventId)
  for (const project of catalog.projects) {
    const inEvent = event?.projects.includes(project.id)
    marks[project.id] = scene === 'engineering' ? {
      reading:capacities.format(project.installedMW)+' MW',
      color:projectColors[(project.cascade-1) % projectColors.length],
    } : {
      reading:inEvent ? event.kind : '第 '+project.cascade+' 级',
      color:inEvent ? kindColors[event.kind] : '#7089a4',
    }
  }
  return marks
}
