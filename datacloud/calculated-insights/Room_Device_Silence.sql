SELECT
  Room_Readings__dlm.device_id__c AS device_id__c,
  DATEDIFF('minute', MAX(Room_Readings__dlm.reading_ts__c), NOW()) AS minutes_since_last_reading__c,
  CASE WHEN DATEDIFF('minute', MAX(Room_Readings__dlm.reading_ts__c), NOW()) > 10 THEN 1 ELSE 0 END AS offline__c
FROM Room_Readings__dlm
GROUP BY device_id__c
