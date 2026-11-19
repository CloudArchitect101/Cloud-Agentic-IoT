SELECT
  Room_Readings__dlm.device_id__c AS device_id__c,
  MAX(Room_Readings__dlm.reading_ts__c) AS last_reading_ts__c,
  COUNT(Room_Readings__dlm.reading_id__c) AS readings__c
FROM Room_Readings__dlm
GROUP BY device_id__c
