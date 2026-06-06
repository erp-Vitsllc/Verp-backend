import { S3Client } from '@aws-sdk/client-s3';
import {
    getS3AccessKey,
    getS3BucketName,
    getS3Endpoint,
    getS3Region,
    getS3SecretKey,
} from './storageConfig.js';

const endpoint = getS3Endpoint();

console.log('Initializing S3 Client with endpoint:', endpoint);

const s3Client = new S3Client({
    region: getS3Region(),
    endpoint,
    credentials: {
        accessKeyId: getS3AccessKey(),
        secretAccessKey: getS3SecretKey(),
    },
    forcePathStyle: true,
});

export const bucketName = getS3BucketName();

export default s3Client;
