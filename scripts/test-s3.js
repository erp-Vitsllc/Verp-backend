import { S3Client, ListBucketsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import {
    getS3AccessKey,
    getS3BucketName,
    getS3Endpoint,
    getS3Region,
    getS3SecretKey,
} from '../config/storageConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const s3Client = new S3Client({
    region: getS3Region(),
    endpoint: getS3Endpoint(),
    credentials: {
        accessKeyId: getS3AccessKey(),
        secretAccessKey: getS3SecretKey(),
    },
    forcePathStyle: true,
});

async function runTest() {
    let output = '';
    const log = (msg) => {
        console.log(msg);
        output += `${msg}\n`;
    };

    try {
        log('--- S3 DIAGNOSTIC (Wasabi) ---');
        log(`ENV Endpoint: ${getS3Endpoint()}`);
        log(`ENV Region: ${getS3Region()}`);
        log(`ENV Bucket: ${getS3BucketName()}`);

        log('\nSTEP 1: LISTING BUCKETS...');
        const listCmd = new ListBucketsCommand({});
        const listRes = await s3Client.send(listCmd);

        log('Success! Found the following buckets:');
        const bucketNames = listRes.Buckets.map((b) => b.Name);
        bucketNames.forEach((b) => log(` - ${b}`));

        const targetBucket = getS3BucketName();
        if (!bucketNames.includes(targetBucket)) {
            log(`\nCRITICAL ERROR: The bucket '${targetBucket}' is NOT in the list above.`);
            log('Create this bucket in the Wasabi console (same region as S3_REGION).');
        } else {
            log(`\nSUCCESS: Target bucket '${targetBucket}' exists.`);

            log(`\nSTEP 2: Attempting upload to '${targetBucket}'...`);
            const putCmd = new PutObjectCommand({
                Bucket: targetBucket,
                Key: 'test-env-upload.txt',
                Body: 'Env var upload test',
                ContentType: 'text/plain',
            });
            await s3Client.send(putCmd);
            log('Success! Test file uploaded.');
        }
    } catch (error) {
        log('\n--- OPERATION FAILED ---');
        log(`Error Name: ${error.name}`);
        log(`Error Message: ${error.message}`);
    } finally {
        fs.writeFileSync(path.join(__dirname, '../s3_buckets_list.txt'), output);
        console.log('Output written to s3_buckets_list.txt');
    }
}

runTest();
