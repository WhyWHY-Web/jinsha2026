

export function forecastUsable(snapshot                 , now=Date.now()) {
  return Number.isFinite(Date.parse(snapshot.retrievedAt)) && Date.parse(snapshot.retrievedAt)<=now+300_000
    && now-Date.parse(snapshot.retrievedAt)<=12*3_600_000 && Date.parse(snapshot.validTo)>now
}

export function forecastDays(station                , now=Date.now()) {
  const groups = new Map                                 ()
  for (const hour of station.hours) {
    if (Date.parse(hour.time)+3_600_000<=now) continue
    // Use the study area's calendar; the source's hourly timestamps remain UTC.
    const date = new Date(Date.parse(hour.time)+8*3_600_000).toISOString().slice(0,10)
    const rows = groups.get(date) ?? []
    rows.push(hour);groups.set(date,rows)
  }
  return [...groups].map(([date,rows])=>{
    const numbers = (key                                          ) => rows.map(row=>row[key]).filter((n)            =>n!==null && Number.isFinite(n))
    const completeSum = (key                      ) => numbers(key).length===rows.length ? numbers(key).reduce((a,b)=>a+b,0) : null
    const precip=completeSum('precipitation'),et0=completeSum('et0')
    const temperatures=numbers('temperature'),vpds=numbers('vpd')
    return {date,hours:rows.length,temperatureCount:temperatures.length,vpdCount:vpds.length,
      maxTemperature:temperatures.length ? Math.max(...temperatures) : null,
      maxVpd:vpds.length ? Math.max(...vpds) : null,precipitation:precip,et0,
      balance:precip===null || et0===null ? null : precip-et0,
      from:rows[0].time,to:rows.at(-1) .time}
  })
}
