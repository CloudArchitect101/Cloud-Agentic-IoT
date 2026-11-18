SELECT
  Room_Reading__dlm.device_id__c AS device_id__c,
  (UNIX_TIMESTAMP(CURRENT_TIMESTAMP()) - UNIX_TIMESTAMP(MAX(Room_Reading__dlm.reading_ts__c))) / 60 AS minutes_since_last_reading__c,
  CASE WHEN UNIX_TIMESTAMP(CURRENT_TIMESTAMP()) - UNIX_TIMESTAMP(MAX(Room_Reading__dlm.reading_ts__c)) > 600 THEN 1 ELSE 0 END AS offline__c
FROM Room_Reading__dlm
GROUP BY device_id__c
