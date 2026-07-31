/*
 * patient-vitals/index.js
 *
 * AWS Lambda function that ingests patient vitals from IoT telemetry,
 * calculates risk scores, and syncs to Salesforce via REST API.
 *
 * This is the first stage of the Data Cloud RAG pipeline:
 * 1. Receives raw telemetry from IoT Core
 * 2. Validates and transforms data
 * 3. Calculates clinical risk scores
 * 4. Syncs to Salesforce (Data Cloud External Object)
 * 5. Stores in DynamoDB for time-series analysis
 *
 * Demonstrates: Data Cloud, RAG pipeline, ETL, data engineering, AWS Lambda
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { URLSearchParams } = require('url');
const jwt = require('jsonwebtoken');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.create({ client: dbClient });

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'patient-vitals';
const SALESFORCE_ENDPOINT = process.env.SALESFORCE_ENDPOINT || 'https://instance.salesforce.com';
const SALESFORCE_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
const SALESFORCE_USERNAME = process.env.SALESFORCE_USERNAME;
const SALESFORCE_JWT_PRIVATE_KEY = process.env.SALESFORCE_JWT_PRIVATE_KEY;
const SALESFORCE_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://test.salesforce.com';

/**
 * Main Lambda handler - processes incoming IoT telemetry events
 *
 * @param {Object} event - IoT event from AWS IoT Core
 * @param {Object} context - Lambda context
 * @returns {Object} Processed result
 */
exports.handler = async (event, context) => {
    console.log('Received event:', JSON.stringify(event));

    try {
        // Extract patient vitals from IoT telemetry payload
        const payload = event.detail || event.payload;
        const vitals = parseVitals(payload);

        if (!vitals) {
            return createResponse(400, { message: 'Invalid vitals payload' });
        }

        // Calculate clinical risk score
        vitals.riskScore = calculateRiskScore(vitals);

        // Classify patient state based on risk
        vitals.patientState = classifyPatientState(vitals.riskScore);

        // DynamoDB keeps every reading (full-fidelity time series).
        // Salesforce deliberately does not: at one reading per 30s a single
        // device produces 2,880 rows/day of mostly "still normal", which
        // fills a Developer Edition org (~5 MB) in under a day and is noise
        // at any scale. Salesforce receives only transitions worth acting on.
        const previousState = await getPreviousState(vitals.deviceId);
        await storeInDynamoDB(vitals);

        const stateChanged = previousState !== vitals.patientState;
        const isAlertable = vitals.patientState !== 'STABLE';
        if (stateChanged || isAlertable) {
            await syncToSalesforce(vitals, { previousState });
        }

        return createResponse(200, {
            message: 'Patient vitals processed successfully',
            deviceId: vitals.deviceId,
            riskScore: vitals.riskScore,
            patientState: vitals.patientState,
            vitals: omit(vitals, 'riskScore', 'patientState')
        });

    } catch (error) {
        console.error('Error processing vitals:', error);
        return createResponse(500, {
            message: 'Failed to process vitals',
            error: error.message
        });
    }
};

/**
 * Parse raw IoT telemetry into structured patient vitals
 * Handles multiple device formats and data sources
 *
 * @param {Object} rawPayload - Raw telemetry from IoT device
 * @returns {Object} Structured vitals object
 */
function parseVitals(rawPayload) {
    try {
        const data = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;

        return {
            deviceId: data.deviceId || data.device_id,
            heartRate: parseFloat(data.heartRate || data.hr || 0),
            spo2: parseFloat(data.spo2 || data.o2_saturation || 98),
            temperature: parseFloat(data.temperature || data.temp || 36.8),
            bloodPressureSystolic: parseFloat(data.bpSystolic || data.bp_sys || 120),
            bloodPressureDiastolic: parseFloat(data.bpDiastolic || data.bp_dia || 80),
            timestamp: data.timestamp || new Date().toISOString(),
            sourceSystem: 'AWS_IoT'
        };
    } catch (error) {
        console.error('Failed to parse vitals:', error);
        return null;
    }
}

/**
 * Calculate clinical risk score (0-100)
 * Based on standard healthcare triage thresholds
 *
 * @param {Object} vitals - Structured patient vitals
 * @returns {number} Risk score from 0 (stable) to 100 (critical)
 */
function calculateRiskScore(vitals) {
    let score = 0;

    // Heart rate assessment (normal: 60-100 bpm)
    if (vitals.heartRate > 0) {
        if (vitals.heartRate < 50 || vitals.heartRate > 120) score += 30;
        else if (vitals.heartRate < 60 || vitals.heartRate > 100) score += 15;
    }

    // SpO2 assessment (normal: 95-100%)
    if (vitals.spo2 > 0) {
        if (vitals.spo2 < 90) score += 35;
        else if (vitals.spo2 < 95) score += 20;
    }

    // Temperature assessment (normal: 36.1-37.2°C)
    if (vitals.temperature > 0) {
        if (vitals.temperature > 39.0 || vitals.temperature < 35.0) score += 25;
        else if (vitals.temperature > 38.5 || vitals.temperature < 36.5) score += 15;
    }

    // Blood pressure assessment (systolic)
    if (vitals.bloodPressureSystolic > 0) {
        if (vitals.bloodPressureSystolic > 160) score += 20;
        else if (vitals.bloodPressureSystolic > 140) score += 10;
    }

    return Math.min(100, score);
}

/**
 * Classify patient state based on risk score
 * Mirrors clinical triage categories
 *
 * @param {number} riskScore - Calculated risk score (0-100)
 * @returns {string} Patient state classification
 */
function classifyPatientState(riskScore) {
    if (riskScore >= 70) return 'CRITICAL';
    if (riskScore >= 40) return 'AT_RISK';
    return 'STABLE';
}

/**
 * Reads the device's last known state from a per-device STATE item.
 * A dedicated item (not a query over the time series) keeps this a single
 * cheap GetItem regardless of history size. Returns null for a new device,
 * which makes the first reading always sync - correct, since "unknown ->
 * anything" is a transition worth recording.
 */
async function getPreviousState(deviceId) {
    const result = await docClient.send(new GetCommand({
        TableName: DYNAMODB_TABLE,
        Key: { PK: `PATIENT#${deviceId}`, SK: 'STATE' },
    }));
    return result.Item ? result.Item.PatientState : null;
}

/**
 * Store vitals in DynamoDB for time-series queries
 * Uses deviceId as partition key, timestamp as sort key.
 * Also maintains the per-device STATE item that getPreviousState reads.
 *
 * @param {Object} vitals - Structured patient vitals
 * @returns {Promise} DynamoDB put operation
 */
async function storeInDynamoDB(vitals) {
    await docClient.send(new PutCommand({
        TableName: DYNAMODB_TABLE,
        Item: {
            PK: `PATIENT#${vitals.deviceId}`,
            SK: 'STATE',
            PatientState: vitals.patientState,
            UpdatedAt: vitals.timestamp,
        },
    }));
    const params = {
        TableName: DYNAMODB_TABLE,
        Item: {
            PK: `PATIENT#${vitals.deviceId}`,
            SK: `VITAL#${vitals.timestamp}`,
            HeartRate: vitals.heartRate,
            SpO2: vitals.spo2,
            Temperature: vitals.temperature,
            BP_Systolic: vitals.bloodPressureSystolic,
            BP_Diastolic: vitals.bloodPressureDiastolic,
            RiskScore: vitals.riskScore,
            PatientState: vitals.patientState,
            SourceSystem: vitals.sourceSystem,
            CreatedAt: vitals.timestamp
        }
    };

    await docClient.send(new PutCommand(params));
}

/**
 * Sync vitals to Salesforce via REST API
 * Uses JWT Bearer Flow for authentication (OAuth 2.0)
 * Creates Patient_Vitals__c records for Data Cloud ingestion
 *
 * @param {Object} vitals - Structured patient vitals
 * @returns {Promise} Salesforce API response
 */
async function syncToSalesforce(vitals, { previousState } = {}) {
    try {
        // Get Salesforce access token using JWT Bearer Flow
        const accessToken = await getSalesforceToken();

        // Upsert on a deterministic external ID (deviceId + timestamp), not
        // create: IoT deliveries retry, and a retried create duplicates the
        // record. Same idempotency pattern as the MuleSoft flow in branch 07.
        const externalId = encodeURIComponent(`${vitals.deviceId}-${vitals.timestamp}`);
        const response = await fetch(`${SALESFORCE_ENDPOINT}/services/data/v59.0/sobjects/Patient_Vitals__c/Device_Reading_Id__c/${externalId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                Device__c: vitals.deviceId,
                Previous_State__c: previousState,
                Heart_Rate__c: vitals.heartRate,
                SpO2__c: vitals.spo2,
                Temperature__c: vitals.temperature,
                BP_Systolic__c: vitals.bloodPressureSystolic,
                BP_Diastolic__c: vitals.bloodPressureDiastolic,
                Timestamp__c: vitals.timestamp,
                Risk_Score__c: vitals.riskScore,
                Patient_State__c: vitals.patientState,
                Source_System__c: vitals.sourceSystem
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Salesforce sync error:', error);
        }

        return response;
    } catch (error) {
        console.error('Failed to sync to Salesforce:', error);
        throw error;
    }
}

/**
 * Authenticate with Salesforce using JWT Bearer Flow (OAuth 2.0)
 * This is the standard pattern for server-to-server Salesforce integration
 *
 * @returns {string} Salesforce access token
 */
async function getSalesforceToken() {
    // JWT Bearer Flow: a signed assertion exchanged for a short-lived token.
    // No password exists anywhere in this system - the username-password
    // OAuth flow is deprecated and blocked by default in current orgs.
    // The private key comes from SSM/Secrets Manager via the environment,
    // same pattern as the Slack integration in branch 04.
    const assertion = jwt.sign(
        {
            iss: SALESFORCE_CLIENT_ID,
            sub: SALESFORCE_USERNAME,
            aud: SALESFORCE_LOGIN_URL,
        },
        SALESFORCE_JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '3m' }
    );

    const response = await fetch(`${SALESFORCE_LOGIN_URL}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        })
    });

    if (!response.ok) {
        throw new Error(`Salesforce JWT auth failed: ${await response.text()}`);
    }
    const data = await response.json();
    return data.access_token;
}

/**
 * Helper to omit fields from an object
 */
function omit(obj, ...keys) {
    const copy = { ...obj };
    keys.forEach(k => delete copy[k]);
    return copy;
}

/**
 * Create standardized API response
 */
function createResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(body)
    };
}
