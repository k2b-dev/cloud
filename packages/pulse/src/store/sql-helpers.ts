/** Per-base views, owned and executed by the service definer; readers get SELECT on these names only. */
export const SQL_HELPER_VIEWS = ["increase", "rate", "histogram_quantile"] as const;

export const sqlHelperStatements = (db: string): string[] => {
  const view = (name: string, query: string) =>
    `CREATE OR REPLACE VIEW ${db}.${name} DEFINER = CURRENT_USER SQL SECURITY DEFINER AS ${query}`;
  // A raw day disappears atomically only after all its hourly values are sealed. Prefer raw hours whenever
  // they exist, including dirty hours, and use rollups strictly before the first retained raw hour per series.
  const counter = `WITH
    selected AS (SELECT * FROM ${db}.series WHERE metric={metric:String} AND type='counter'),
    raw AS (SELECT p.series_id,p.ts,p.value FROM ${db}.samples p INNER JOIN selected s USING(series_id) WHERE p.ts<{to:DateTime64(3)}),
    floors AS (SELECT series_id,toStartOfHour(min(ts)) AS raw_floor FROM raw GROUP BY series_id),
    old AS (SELECT r.* FROM ${db}.rollups r INNER JOIN selected s USING(series_id) LEFT JOIN floors f USING(series_id)
      WHERE r.bucket+INTERVAL 1 HOUR>{from:DateTime64(3)} AND r.bucket<{to:DateTime64(3)}
        AND (r.series_id NOT IN (SELECT series_id FROM floors) OR r.bucket<f.raw_floor)),
    old_totals AS (SELECT series_id,sum(increase) AS delta,sum(increase_seconds) AS seconds,
      max(if(bucket<{from:DateTime64(3)} OR bucket+INTERVAL 1 HOUR>{to:DateTime64(3)},1,0)) AS partial FROM old GROUP BY series_id),
    seeds AS (SELECT series_id,argMax(value,ts) AS value,max(ts) AS ts FROM (
      SELECT series_id,value,ts FROM raw WHERE ts<{from:DateTime64(3)}
      UNION ALL SELECT r.series_id,r.last_value AS value,r.last_ts AS ts FROM ${db}.rollups r INNER JOIN selected s USING(series_id) LEFT JOIN floors f USING(series_id)
        WHERE r.last_ts<{to:DateTime64(3)} AND (r.last_ts<{from:DateTime64(3)} OR
          (r.series_id IN (SELECT series_id FROM floors) AND r.bucket<f.raw_floor))
    ) GROUP BY series_id),
    points AS (SELECT series_id,ts,value,1 AS inside FROM raw WHERE ts>={from:DateTime64(3)}
      UNION ALL SELECT series_id,ts,value,0 AS inside FROM seeds),
    pairs AS (SELECT *,lagInFrame(toNullable(value),1,NULL) OVER w AS previous_value,
      lagInFrame(toNullable(ts),1,NULL) OVER w AS previous_ts FROM points
      WINDOW w AS (PARTITION BY series_id ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)),
    raw_totals AS (SELECT series_id,coalesce(sumIf(if(value>=previous_value,value-previous_value,value),inside=1 AND previous_value IS NOT NULL),0) AS delta,
      coalesce(sumIf(dateDiff('millisecond',previous_ts,ts)/1000.0,inside=1 AND previous_ts IS NOT NULL),0) AS seconds FROM pairs GROUP BY series_id),
    totals AS (SELECT series_id,sum(delta) AS delta,sum(seconds) AS seconds,max(partial) AS partial FROM (
      SELECT series_id,delta,seconds,partial FROM old_totals UNION ALL SELECT series_id,delta,seconds,0 AS partial FROM raw_totals
    ) GROUP BY series_id)
    SELECT s.series_id,s.metric,s.dimensions,s.resource_key,s.source_id,
      t.delta+throwIf({from:DateTime64(3)}>={to:DateTime64(3)},'from must be before to')
        +throwIf(t.partial=1,'Expired raw data requires complete hourly windows') AS increase,t.seconds AS seconds
    FROM totals t INNER JOIN selected s USING(series_id)`;
  // Quantiles stay separate for every source/resource/label group. Bucket counts are cumulative; the
  // Prometheus aggregate consumes the summed reset-safe increases, never per-scrape quantiles.
  const histogram = `WITH
    buckets AS (SELECT *,JSONExtractString(dimensions,'le') AS le,
      arraySort(arrayFilter(x->x.1!='le',JSONExtractKeysAndValues(dimensions,'String'))) AS labels
      FROM ${db}.series WHERE metric=concat({metric:String},'_bucket') AND type='counter'),
    raw_floors AS (SELECT series_id,toStartOfHour(min(ts)) AS raw_floor FROM ${db}.samples GROUP BY series_id),
    observations AS (SELECT p.ts AS at,b.source_id,b.resource_key,b.labels,arraySort(groupUniqArray(b.le)) AS bounds
      FROM (SELECT series_id,ts FROM ${db}.samples WHERE ts>={from:DateTime64(3)} AND ts<{to:DateTime64(3)}
        UNION ALL SELECT r.series_id,toDateTime64(r.bucket,3) AS ts FROM ${db}.rollups r LEFT JOIN raw_floors f USING(series_id)
          WHERE r.bucket>={from:DateTime64(3)} AND r.bucket<{to:DateTime64(3)} AND (r.series_id NOT IN (SELECT series_id FROM raw_floors) OR r.bucket<f.raw_floor)) p
      INNER JOIN buckets b USING(series_id) GROUP BY p.ts,b.source_id,b.resource_key,b.labels),
    signatures AS (SELECT *,first_value(bounds) OVER w AS initial_bounds FROM observations
      WINDOW w AS (PARTITION BY source_id,resource_key,labels ORDER BY at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)),
    changes AS (SELECT source_id,resource_key,labels,minIf(at,bounds!=initial_bounds) AS changed_at,countIf(bounds!=initial_bounds) AS changes
      FROM signatures GROUP BY source_id,resource_key,labels),
    old_checks AS (SELECT r.bucket AS at,b.source_id,b.resource_key,b.labels,uniqExact(r.sample_count)>1 OR uniqExact(r.last_ts)>1 AS changed
      FROM ${db}.rollups r INNER JOIN buckets b USING(series_id) LEFT JOIN raw_floors f USING(series_id)
      WHERE r.bucket>={from:DateTime64(3)} AND r.bucket<{to:DateTime64(3)} AND (r.series_id NOT IN (SELECT series_id FROM raw_floors) OR r.bucket<f.raw_floor)
      GROUP BY r.bucket,b.source_id,b.resource_key,b.labels),
    all_changes AS (SELECT source_id,resource_key,labels,min(changed_at) AS changed_at,sum(changes) AS changes FROM (
      SELECT source_id,resource_key,labels,changed_at,changes FROM changes WHERE changes>0
      UNION ALL SELECT source_id,resource_key,labels,at AS changed_at,toUInt64(1) AS changes FROM old_checks WHERE changed
    ) GROUP BY source_id,resource_key,labels),
    increases AS (SELECT i.increase,b.source_id,b.resource_key,b.labels,b.le
      FROM ${db}.increase(metric=concat({metric:String},'_bucket'),from={from:DateTime64(3)},to={to:DateTime64(3)}) i INNER JOIN buckets b USING(series_id)),
    summed AS (SELECT source_id,resource_key,labels,le,sum(increase) AS cumulative FROM increases GROUP BY source_id,resource_key,labels,le),
    result AS (SELECT source_id,resource_key,labels,
      quantilePrometheusHistogram({quantile:Float64})(if(le='+Inf',toFloat64('inf'),toFloat64(le)),toFloat64(cumulative)) AS value
      FROM summed GROUP BY source_id,resource_key,labels)
    SELECT g.source_id,g.resource_key,toJSONString(mapFromArrays(arrayMap(x->x.1,g.labels),arrayMap(x->x.2,g.labels))) AS dimensions,
      g.value+throwIf({quantile:Float64}<0 OR {quantile:Float64}>1,'quantile must be between 0 and 1')
        +toFloat64(if(c.changes>0,concat('Histogram bucket bounds changed at ',toString(c.changed_at)),'0')) AS quantile
    FROM result g LEFT JOIN all_changes c ON g.source_id IS NOT DISTINCT FROM c.source_id AND g.resource_key=c.resource_key AND g.labels=c.labels`;
  return [
    view("increase", counter),
    view(
      "rate",
      `SELECT *,increase/nullIf(seconds,0) AS rate FROM ${db}.increase(metric={metric:String},from={from:DateTime64(3)},to={to:DateTime64(3)})`,
    ),
    view("histogram_quantile", histogram),
  ];
};
