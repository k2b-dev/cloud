SELECT toString(bucket(ts, :bucket)) AS day,
       JSONExtractString(dimensions, 'path') AS path,
       countIf(kind = 'page_view') AS views,
       uniqExactIf(session_id, kind = 'page_view') AS sessions,
       countIf(kind = 'contact_form_sent') AS contacts
FROM events
GROUP BY day, path
ORDER BY day, path
