export type Freshness = 'fresh'|'delayed'|'failed'|'invalid'|'missing'|'archive'|'offline'
export type SourceStatus = {
  id:string; label:string; source:string; sourceUrl:string; kind:string; version:string;
  observedAt:string|null; issuedAt:string|null; retrievedAt:string|null; lastSuccessAt:string|null;
  lastAttemptAt:string|null; nextCheckAt:string|null; staleAfterHours:number|null;
  validFrom:string|null; validTo:string|null; state:Freshness; detail:string;
  coverage:{valid:number;total:number;unit:string}|null; contentHash:string|null
}
export type ForecastHour = {time:string;temperature:number|null;humidity:number|null;precipitation:number|null;et0:number|null;vpd:number|null}
export type ForecastStation = {
  id:string;name:string;lon:number;lat:number;elevation:number|null;
  grid:{lon:number;lat:number;elevation:number|null};hours:ForecastHour[]
}
export type ForecastSnapshot = {
  id:string;sha256:string;source:string;sourceUrl:string;productVersion:string;sourceKind:'model_forecast';
  issuedAt:null;retrievedAt:string;validFrom:string;validTo:string;modelStatus:'drivers_only';
  stations:ForecastStation[];notes:string[]
}
export type ObservationStation = {
  id:string;name:string;lon:number;lat:number;elevation:number|null;retrievedAt:string;
  observedAt:string|null;sha256:string;qualityRejected:number;
  latest:Record<string,{date:string;value:number;unit:string}>;
  recent:{date:string;element:string;value:number;unit:string}[];error?:string
}
export type ObservationSnapshot = {source:string;sourceUrl:string;retrievedAt:string;stations:ObservationStation[];notes:string[]}
export type LiveStatus = {
  asOf:string;mode:'service'|'snapshot';collecting:boolean;sources:SourceStatus[];
  history:{at:string;source:string;ok:boolean;detail:string}[]
}
