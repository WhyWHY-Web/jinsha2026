import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { FloodArchive, FloodEvent, FloodFrame, FloodStation } from '../data/flood/types.ts'

const inflate = promisify(gunzip)
const source = 'Copernicus GloFAS v4 · Open-Meteo 历史日流量'
const sourceUrl = 'https://open-meteo.com/en/docs/flood-api'
const hoursPerDay = 24
const daysPerWindowSide = 10
const numberOfEvents = 8
const stations = [
  { id: 'shigu', name: '石鼓' },
  { id: 'panzhihua', name: '攀枝花' },
  { id: 'pingshan', name: '屏山' },
  { id: 'xiangjiaba', name: '向家坝' },
] as const
const referenceId = 'xiangjiaba'

type SourceGrid = {
  latitude: number
  longitude: number
  utc_offset_seconds: number
  daily_units: { river_discharge: string }
  daily: { time: string[]; river_discharge: number[] }
}
type ArchiveData = { dates: string[]; grids: SourceGrid[]; replay: FloodArchive }
type Cache = { path: string; modified: number; size: number; data: Promise<ArchiveData> }
let cache: Cache | undefined

function buildArchive(grids: SourceGrid[]): ArchiveData {
  const dates = grids[0]?.daily.time
  if (!dates?.length || grids.length !== stations.length || grids.some(grid =>
    grid.utc_offset_seconds !== 0 || grid.daily_units.river_discharge !== 'm³/s'
    || grid.daily.river_discharge.length !== dates.length || grid.daily.time.length !== dates.length
    || grid.daily.time.some((date, index) => date !== dates[index])
    || grid.daily.river_discharge.some(value => !Number.isFinite(value) || value < 0))) {
    throw new Error('GloFAS 日流量档案的时间轴、单位或记录数不匹配')
  }
  const firstDate = Date.parse(dates[0])
  const msPerDay = hoursPerDay * 60 * 60 * 1000
  if (dates.some((date, index) => Date.parse(date) !== firstDate + index * msPerDay)) {
    throw new Error('GloFAS 日流量档案缺少连续日期')
  }

  const stationMetadata: FloodStation[] = stations.map((station, index) => {
    const grid = grids[index]
    const values = [...grid.daily.river_discharge].sort((a, b) => a - b)
    const threshold = values[Math.ceil(values.length * 0.95) - 1]
    return { ...station, grid: { lat: grid.latitude, lon: grid.longitude }, threshold }
  })

  const referenceIndex = stations.findIndex(station => station.id === referenceId)
  const reference = stationMetadata[referenceIndex]
  const referenceValues = grids[referenceIndex].daily.river_discharge
  const strongestPerYear = new Map<string, number>()
  dates.forEach((date, index) => {
    const year = date.slice(0, 4)
    const previous = strongestPerYear.get(year)
    if (previous === undefined || referenceValues[index] > referenceValues[previous]) {
      strongestPerYear.set(year, index)
    }
  })

  const events: FloodEvent[] = [...strongestPerYear.values()]
    .filter(index => referenceValues[index] >= reference.threshold)
    .sort((a, b) => referenceValues[b] - referenceValues[a])
    .slice(0, numberOfEvents)
    .map(peakIndex => {
      const startIndex = Math.max(0, peakIndex - daysPerWindowSide)
      const endIndex = Math.min(dates.length - 1, peakIndex + daysPerWindowSide)
      const frames = dates.slice(startIndex, endIndex + 1).map<FloodFrame>((date, offset) => ({
        date,
        stations: stationMetadata.map((station, stationIndex) => {
          const value = grids[stationIndex].daily.river_discharge[startIndex + offset]
          const relative = station.threshold > 0 ? value / station.threshold : 0
          return {
            id: station.id, name: station.name, value, relative,
            level: relative >= 1.2 ? 'veryHigh' : relative >= 1 ? 'high' : 'usual',
          }
        }),
      }))
      return {
        id: dates[peakIndex], start: dates[startIndex], end: dates[endIndex], peakDate: dates[peakIndex],
        peak: referenceValues[peakIndex],
        daysAbove: referenceValues.slice(startIndex, endIndex + 1).filter(value => value >= reference.threshold).length,
        frames,
      }
    })

  return {
    dates, grids,
    replay: {
      source, sourceUrl, start: dates[0], end: dates.at(-1)!, rows: dates.length * stations.length,
      method: '按向家坝格点每年最高日流量排序，取前八年重放峰值日前后各十日。参考值为各格点自身历史日流量的第 95 百分位。',
      referenceId, stations: stationMetadata, events,
    },
  }
}

async function readArchive(newData: string) {
  const path = join(newData, 'flood', 'glofas-daily.json.gz')
  const file = await stat(path)
  if (!cache || cache.path !== path || cache.modified !== file.mtimeMs || cache.size !== file.size) {
    const data = readFile(path).then(buffer => inflate(buffer)).then(buffer => buildArchive(JSON.parse(buffer.toString('utf8'))))
    cache = { path, modified: file.mtimeMs, size: file.size, data }
    data.catch(() => { if (cache?.data === data) cache = undefined })
  }
  return cache.data
}

export async function readFloodReplay(newData: string) {
  return (await readArchive(newData)).replay
}

export async function readFloodSeries(newData: string, stationId: string, year: number) {
  const index = stations.findIndex(station => station.id === stationId)
  if (index === -1) return null
  const { dates, grids, replay } = await readArchive(newData)
  const values = grids[index].daily.river_discharge
  const yearPrefix = `${year}-`
  return {
    station: replay.stations[index], year, source, sourceUrl, unit: 'm³/s',
    rows: dates.flatMap((date, i) => date.startsWith(yearPrefix) ? [{ date, value: values[i] }] : []),
  }
}
