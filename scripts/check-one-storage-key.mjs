import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import s3Client from '../config/s3Client.js';
import { getS3ReadBucketNames } from '../config/storageConfig.js';

const prefix = 'company-documents/EST-003/96553999-c5dd-4bd1-9fc8-10e1d76d15fd';
const buckets = getS3ReadBucketNames();
const out = [];

for (const bucket of buckets) {
    try {
        const found = await s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 20,
        }));
        out.push({
            bucket,
            count: found.KeyCount || 0,
            keys: (found.Contents || []).map((item) => ({
                key: item.Key,
                bytes: item.Size ?? null,
            })),
        });
    } catch (error) {
        out.push({
            bucket,
            error: error?.name || 'error',
            status: error?.$metadata?.httpStatusCode || null,
        });
    }
}

console.log(JSON.stringify({ prefix, out }, null, 2));
