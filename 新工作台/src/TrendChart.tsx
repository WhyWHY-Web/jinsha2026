import { useEffect, useMemo, useRef } from 'react'
import type { Point } from './data'

export function TrendChart({ points, year, color, onSelect, label='年度趋势', unit }: {
  points: Point[], year: number, color: string, onSelect: (year: number) => void; label?:string; unit?:string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const nearest = useRef<Array<{ x: number, year: number }>>([])
  const samples = useMemo(()=>points.filter(p=>Number.isFinite(p.year) && p.value != null && Number.isFinite(p.value)),[points])
  const validYears = [...new Set(samples.map(point=>point.year))].sort((a,b)=>a-b)
  const selected = samples.find(point=>point.year===year)
  useEffect(() => {
    nearest.current = []
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      nearest.current = []
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w <= 80 || h <= 40) return
      const dpr = Math.min(devicePixelRatio || 1, 2)
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      if (!samples.length) return
      const values = samples.map(p => p.value!)
      const low = Math.min(...values), high = Math.max(...values)
      const padding = Math.max((high - low) * .16, 0.001)
      const min = low - padding, max = high + padding
      const digits = high > 100 ? 0 : high > 2 ? 1 : 2
      ctx.font = '11px Segoe UI'
      const left = Math.max(38,ctx.measureText(min.toFixed(digits)).width+8,ctx.measureText(max.toFixed(digits)).width+8)
      const top = 10, bottom = h - 24, right = w - 20
      const start = Math.min(...samples.map(point=>point.year)), end = Math.max(...samples.map(point=>point.year))
      const posX = (v: number) => left + (right-left)*(v-start)/Math.max(1,end-start)
      const posY = (v: number) => bottom - (bottom-top)*(v-min)/(max-min)
      nearest.current = samples.map(p => ({ x: posX(p.year), year: p.year }))
      ctx.fillStyle = '#8eaecf'
      for (let i=0; i<4; i++) {
        const y = top + (bottom-top)*i/3
        const v = max - (max-min)*i/3
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
        if (!Number.isFinite(point.year) || point.value == null || !Number.isFinite(point.value)) { started = false; continue }
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
  }, [points, samples, year, color])
  if (!samples.length) return <div className="empty-chart" role="status">{label}：所选范围暂无可绘制的年值</div>
  const valueText = selected ? `${year}年：${selected.value!.toLocaleString('zh-CN',{maximumFractionDigits:3})}${unit?' '+unit:''}` : `${year}年暂无有效值，使用方向键选择有效年份`
  return <canvas ref={ref} role="slider" tabIndex={0} aria-label={label+(unit?'，单位'+unit:'')+'，点击或使用左右方向键、Home、End选择年份'}
    aria-orientation="horizontal" aria-valuemin={Math.min(year,validYears[0])} aria-valuemax={Math.max(year,validYears[validYears.length-1])}
    aria-valuenow={year} aria-valuetext={valueText} onKeyDown={event=>{
      let next:number | undefined
      if (event.key==='Home') next=validYears[0]
      else if (event.key==='End') next=validYears[validYears.length-1]
      else if (event.key==='ArrowRight') next=validYears.find(value=>value>year) ?? validYears[validYears.length-1]
      else if (event.key==='ArrowLeft') next=validYears.filter(value=>value<year).at(-1) ?? validYears[0]
      else return
      event.preventDefault()
      if (next!==undefined && next!==year) onSelect(next)
    }} onClick={event => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    const match = nearest.current.reduce<{ x: number, year: number } | undefined>((a,b) => !a || Math.abs(b.x-x)<Math.abs(a.x-x) ? b : a, undefined)
    if(match) onSelect(match.year)
  }}/>
}
