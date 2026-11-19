SELECT
  Room_Readings__dlm.device_id__c AS device_id__c,
  DATE_TRUNC('day', Room_Readings__dlm.reading_ts__c) AS reading_day__c,
  COUNT(Room_Readings__dlm.reading_id__c) AS readings_out_of_range__c,
  COUNT(Room_Readings__dlm.reading_id__c) * 0.5 AS minutes_out_of_range__c,
  MAX(Room_Readings__dlm.temperature_c__c) AS max_temperature_c__c
FROM Room_Readings__dlm
WHERE Room_Readings__dlm.temperature_c__c >= 30.0
GROUP BY device_id__c, reading_day__c
