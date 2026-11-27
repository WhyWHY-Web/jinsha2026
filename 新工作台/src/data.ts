export type Scene = 'ecology' | 'overview' | 'vegetation' | 'water' | 'engineering' | 'dispatch' | 'flood' | 'quality' | 'emergency' | 'data'
export type Metric = 'ndvi' | 'temperature' | 'precipitation' | 'evapotranspiration' | 'discharge'

export interface MapLocation {
  id: string
  name: string
  lon: number
  lat: number
}

export interface StationMark {
  reading?: string
  color?: string
}

export interface Station {
  id: string
  name: string
  en?: string
  lon: number
  lat: number
  type: string
  zone: string
  elevation: number | null
  temp: number | null
  precip: number | null
  cover: Record<string, number> | null
  assessment?: Record<string, unknown> | null
}
export interface ClimatePoint {
  year: number
  temp: number | null
  precip: number | null
  et: number | null
  samples?: number
  scope?: string
}
export interface Point {
  year: number
  value: number | null
  samples?: number
}
export interface Dataset {
  id?: string
  name?: string
  label?: string
  source?: string
  count?: number
  records?: number
  rows?: number
  queryable?: boolean
  kind?: string
  startYear?: number
  endYear?: number
  description?: string
  sourceUrl?: string
  licenseUrl?: string
  note?: string
  years?: string | number[]
}
export interface MapConfig {
  bounds: [number, number, number, number]
  terrainUrl: string
  terrainMaxZoom?: number
  regionalTerrain?: { url:string; bounds:[number,number,number,number] }
  imageryUrl?: string
  fallbackImageUrl: string
  riverUrl: string
  mainstemProductUrl?: string
  basinUrl: string
  context?: { url: string, bounds: [number,number,number,number] }
  expandedRiverUrl?: string
  expandedRiverBounds?: [number, number, number, number]
}

export interface RseiLayer {
  year: number
  values: Record<string,number | null>
  coverage: Record<string,number>
}
export interface Dashboard {
  stations: Station[]
  climate: ClimatePoint[]
  ndvi: Point[]
  catalog: Dataset[]
  runoffStations?: string[]
  map: MapConfig
}
export interface Series {
  metric: Metric
  source?: string
  unit?: string
  data?: Point[]
  points?: Point[]
  values?: Point[]
}
