export type FloodLevel = 'usual' | 'high' | 'veryHigh'

export interface FloodStation {
  id: string
  name: string
  grid: { lat: number; lon: number }
  threshold: number
}

export interface FloodStationDay {
  id: string
  name: string
  value: number
  relative: number
  level: FloodLevel
}

export interface FloodFrame {
  date: string
  stations: FloodStationDay[]
}

export interface FloodEvent {
  id: string
  start: string
  end: string
  peakDate: string
  peak: number
  daysAbove: number
  frames: FloodFrame[]
}

export interface FloodArchive {
  source: string
  sourceUrl: string
  method: string
  start: string
  end: string
  rows: number
  referenceId: string
  stations: FloodStation[]
  events: FloodEvent[]
}
