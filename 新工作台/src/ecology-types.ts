export type AmendmentField = 'temperature' | 'precipitation'

export interface AmendmentDraft {
  stationIds: string[]
  field: AmendmentField
  year: number
  value: number
  source: string
  reason: string
}

export interface AmendmentEntry extends AmendmentDraft {
  id: number
  createdAt: string
  reverted: boolean
}

export interface AmendmentHistory {
  revision: number
  entries: AmendmentEntry[]
}

export interface AmendmentPreview {
  revision: number
  previous: { stationId: string; name: string; value: number | null }[]
  count: number
}

export interface AgentAction {
  type: 'showStation' | 'showAssessment' | 'showData' | 'draftAmendment'
  stationId?: string
  scope?: string
  year?: number
  field?: AmendmentField
  value?: number
}

export interface AgentReply {
  answer: string
  evidence: { label: string; detail: string; url?: string }[]
  mode: 'local' | 'ollama'
  action?: AgentAction
}

export interface AssessmentScope {
  id: string
  name: string
  kind: string
}

export interface AssessmentRegion extends AssessmentScope {
  count: number
}

export interface AssessmentScenario {
  id: string
  name: string
  description: string
  inputRole?:string
}

export interface EcologyMetric {
  id: string
  name: string
  unit: string
  description: string
  inputRole?:string
}

export type MetricValues = Record<string, number | null>

export interface EcologyOptions {
  regions: AssessmentRegion[]
  years: number[]
  scenarios: AssessmentScenario[]
  metricDefinitions: EcologyMetric[]
}

export interface EcologyStation {
  id: string
  name: string
  lat: number
  lon: number
  zone: string
  metrics: MetricValues
  grade: string
  riskLevel: string
  inputs: {
    temp: number
    precip: number
    slope: number
    relief: number
    cover: Record<string, number>
    year: number | null
    climateSource: string
    coverSource: string
    amendedFields: ('temp' | 'precip')[]
  }
  baselineMetrics: MetricValues
  delta: MetricValues
  ndvi: number | null
}

export interface AssessmentReport {
  ok: boolean
  method: string
  scope: AssessmentScope
  year: number | null
  scenario: AssessmentScenario
  summary: {
    spatialSupport:string
    totalBasins:number
    sampledBasins:number
    count: number
    eligible: number
    means: MetricValues | null
    grades: Record<string,number>
    riskLevels: Record<string,number>
  }
  stations: EcologyStation[]
  metricDefinitions: EcologyMetric[]
  quality: {
    notes: string[]
    missingStations: string[]
    anomalies: {
      stationId: string
      station: string
      field: string
      name: string
      unit: string
      value: number
      reference: number
      z: number
      relativePct: number
      nearestKm: number
      elevationDifferenceM:number
      referenceInsufficient:boolean
      level: string
      note: string
    }[]
  }
  comparison: {
    year: number
    count: number
    means: MetricValues | null
    delta: MetricValues | null
    currentMeans:MetricValues | null
  } | null
  run:{id:string;sha256:string;generatedAt:string;parameters:{scope:string;bbox:number[]|null;year:number|null;compareYear:number|null;scenario:string};hashScope:string}
  modelCard:{version:string;purpose:string;eeiRange:string;formula:string;gradeBasis:string;spatialSupport:string;inputs:{annual:string;fixed:string;validation:string};domain:string;validation:string;standard:string}
}

export interface RseiArchive {
  source: string
  mode: string
  spatialResultsVerified: boolean
  records: {
    year: number
    sensor: string
    scenes: number
    value: number | null
    coverageKm2: number | null
    loadings: Record<string, number>
    components: Record<'ndvi' | 'wet' | 'ndbsi' | 'lst', number>
    classes: (number | null)[]
  }[]
  research: {
    version: string
    source: string
    boundarySha256: string
    rasterSources: { year:number; file:string; sha256:string }[]
    pixelSizeDegrees: number
    crs: string
    note: string
    region: {
      id: string
      areaKm2: number
      records: {
        year: number
        value: number | null
        coverageKm2: number
        validPixels: number
        ambiguousZeroPixels: number
        allYearsCommon: { value:number | null; coverageKm2:number; validPixels:number }
      }[]
      pairs: {
        startYear: number
        endYear: number
        startValue: number | null
        endValue: number | null
        delta: number | null
        coverageKm2: number
        validPixels: number
      }[]
    }
  } | null
  notes: string[]
}

export interface SoilArchive {
  archive: {
    rows: number
    source: string
    description: string
    fields: { field:string; label:string; unit:string }[]
  }
  scope: { kind:string; id:string }
  profiles: {
    depth: string
    inside: number
    samples: number
    coverage: number
    properties: Record<string, { mean:number | null; min:number | null; max:number | null; p10:number | null; median:number | null; p90:number | null }>
  }[]
}
