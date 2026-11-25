/*
 * PatientVitalsRetentionJob.cls
 *
 * Deletes Patient_Vitals__c records older than
 * Device_Platform_Setting__mdt.Vitals_Retention_Days__c (90 by default).
 *
 * Salesforce keeps only the readings someone had to act on (alerts and state
 * changes); every reading stays in the S3 archive and the Data Cloud copy.
 * Each record is about 2 KB of data storage, so without this a fleet fills the
 * org: 10,000 hot devices at 2 records a day is about 40 MB a day, a year of
 * it about 14 GB (docs/SCALING.md, "Salesforce API calls per device").
 * Deleting from Apex costs no API request.
 *
 * Schedule it once, nightly at 02:00:
 *   System.schedule('Patient vitals retention', '0 0 2 * * ?', new PatientVitalsRetentionJob());
 * Blank Vitals_Retention_Days__c keeps everything and the job does nothing.
 */
public with sharing class PatientVitalsRetentionJob implements Schedulable, Database.Batchable<SObject> {

    public void execute(SchedulableContext context) {
        if (DevicePlatformSettings.vitalsRetentionDays() != null) {
            Database.executeBatch(new PatientVitalsRetentionJob(), 2000);
        }
    }

    public Database.QueryLocator start(Database.BatchableContext context) {
        Integer days = DevicePlatformSettings.vitalsRetentionDays();
        if (days == null) {
            return Database.getQueryLocator([SELECT Id FROM Patient_Vitals__c WHERE Id = null]);
        }
        Datetime cutoff = Datetime.now().addDays(-days);
        return Database.getQueryLocator([SELECT Id FROM Patient_Vitals__c WHERE CreatedDate < :cutoff]);
    }

    public void execute(Database.BatchableContext context, List<SObject> expired) {
        // Partial success: a record someone locked is tried again tomorrow.
        List<Id> deleted = new List<Id>();
        for (Database.DeleteResult result : Database.delete(expired, false)) {
            if (result.isSuccess()) {
                deleted.add(result.getId());
            }
        }
        // Out of the Recycle Bin too, which counts against storage as well.
        if (!deleted.isEmpty()) {
            Database.emptyRecycleBin(deleted);
        }
    }

    public void finish(Database.BatchableContext context) {
    }
}
