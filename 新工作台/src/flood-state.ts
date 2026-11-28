import { useEffect, useState } from 'react'
import type { FloodArchive, FloodLevel } from '../data/flood/types'

export const floodColors: Record<FloodLevel, string> = {
  usual: '#67cfff',
  high: '#ffd081',
  veryHigh: '#ff785d',
}

const levels: Record<FloodLevel, { label: string, range: string }> = {
  usual: { label:'低于参考值', range:'< 1.0 倍 P95' },
  high: { label:'达到参考值', range:'1.0 ≤ 倍数 < 1.2' },
  veryHigh: { label:'明显高于参考值', range:'≥ 1.2 倍 P95' },
}
const playbackRates = [.5, 1, 2, 4] as const
type PlaybackRate = typeof playbackRates[number]
const formatFlow = new Intl.NumberFormat('zh-CN', { maximumFractionDigits:0 }).format

export function useFloodReplay(active: boolean) {
  const [archive,setArchive] = useState<FloodArchive | null>(null)
  const [failed,setFailed] = useState(false)
  const [attempt,setAttempt] = useState(0)
  const [eventId,setEventId] = useState<string | null>(null)
  const [selectedIndex,setSelectedIndex] = useState<number | null>(null)
  const [playing,setPlaying] = useState(false)
  const [speed,setSpeed] = useState<PlaybackRate>(1)

  useEffect(() => {
    if (!active || archive) return
    const controller = new AbortController()
    fetch('/api/flood/replay',{ signal:controller.signal }).then(response => {
      if (!response.ok) throw new Error('历史流量档案读取失败')
      return response.json() as Promise<FloodArchive>
    }).then(setArchive).catch(error => {
      if (error.name !== 'AbortError') setFailed(true)
    })
    return () => controller.abort()
  },[active,archive,attempt])

  const event = archive?.events.find(item=>item.id===eventId) ?? archive?.events[0]
  const peakIndex = Math.max(0, event?.frames.findIndex(item=>item.date===event.peakDate) ?? 0)
  const index = selectedIndex ?? peakIndex
  const frame = event?.frames[index]
  const lastIndex = Math.max(0,(event?.frames.length ?? 1)-1)

  useEffect(() => {
    if (!active) setPlaying(false)
  },[active])

  useEffect(() => {
    if (!active || !playing) return
    const timer = window.setTimeout(() => {
      const next = Math.min(lastIndex,index+1)
      setSelectedIndex(next)
      if (next === lastIndex) setPlaying(false)
    },850/speed)
    return () => window.clearTimeout(timer)
  },[active,playing,speed,index,lastIndex])

  function selectEvent(id: string) {
    setEventId(id)
    setSelectedIndex(null)
    setPlaying(false)
  }

  function selectFrame(value: number) {
    setSelectedIndex(Math.max(0,Math.min(lastIndex,value)))
    setPlaying(false)
  }

  function toggle() {
    if (lastIndex < 1) return
    if (!playing && (selectedIndex === null || index === lastIndex)) setSelectedIndex(0)
    setPlaying(!playing)
  }

  function retry() {
    setFailed(false)
    setAttempt(value=>value+1)
  }

  return { archive, failed, event, frame, index, lastIndex, peakIndex, playing, speed, setSpeed, selectEvent, selectFrame, toggle, retry }
}
