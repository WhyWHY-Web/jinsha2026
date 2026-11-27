import { useEffect, useRef } from 'react'
import type { Point } from './data'

export function TrendChart({ points, year, color, onSelect }: {
  points: Point[], year: number, color: string, onSelect: (year: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const nearest = useRef<Array<{ x: number, year: number }>>([])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w <= 10 || h <= 10) return
      const dpr = Math.min(devicePixelRatio || 1, 2)
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      const samples = points.filter(p => p.value != null && Number.isFinite(p.value))
      if (!samples.length) return
      const values = samples.map(p => p.value!)
      const low = Math.min(...values), high = Math.max(...values)
      const padding = Math.max((high - low) * .16, 0.001)
      const min = low - padding, max = high + padding
      const top = 10, bottom = h - 22, left = 32, right = w - 8
      const start = samples[0].year, end = samples[samples.length - 1].year
      const posX = (v: number) => left + (right-left)*(v-start)/Math.max(1,end-start)
      const posY = (v: number) => bottom - (bottom-top)*(v-min)/(max-min)
      nearest.current = samples.map(p => ({ x: posX(p.year), year: p.year }))
      ctx.font = '9px Segoe UI'
      ctx.fillStyle = '#8eaecf'
      for (let i=0; i<4; i++) {
        const y = top + (bottom-top)*i/3
        const v = max - (max-min)*i/3
        const digits = high > 100 ? 0 : high > 2 ? 1 : 2
        ctx.fillText(v.toFixed(digits), 0, y+3)
        ctx.strokeStyle = '#263c57'
        ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(right,y); ctx.stroke()
      }
      const years = Array.from(new Set([start, Math.round((start+end)/2),end]))
      ctx.textAlign = 'center'
      for (const value of years) ctx.fillText(String(value), posX(value), h-6)
      ctx.beginPath()
      let started = false
      let prior = start
      for (const point of points) {
        if (point.value == null) { started = false; continue }
        const x=posX(point.year), y=posY(point.value)
        if (started && point.year === prior + 1) ctx.lineTo(x,y)
        else ctx.moveTo(x,y)
        started = true
        prior = point.year
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke()
      if (year >= start && year <= end) {
        const x = posX(year)
        ctx.strokeStyle = '#819bbb'; ctx.setLineDash([3,3])
        ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.setLineDash([])
        const point = samples.find(p => p.year === year)
        if (point?.value != null) {
          ctx.fillStyle = color;ctx.beginPath();ctx.arc(x,posY(point.value),3.4,0,Math.PI*2);ctx.fill()
        }
      }
    }
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [points, year, color])
  if (!points.some(p => p.value != null)) return <div className="empty-chart">所选范围暂无可绘制的年值</div>
  return <canvas ref={ref} aria-label="年度趋势图，点击可切换年份" onClick={event => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    const match = nearest.current.reduce<{ x: number, year: number } | undefined>((a,b) => !a || Math.abs(b.x-x)<Math.abs(a.x-x) ? b : a, undefined)
    if(match) onSelect(match.year)
  }}/>
}
