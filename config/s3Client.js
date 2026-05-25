import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.IDRIVE_ENDPOINT && !process.env.IDRIVE_ENDPOINT.startsWith('http')
    ? `https://${process.env.IDRIVE_ENDPOINT}`
    : process.env.IDRIVE_ENDPOINT;

console.log('Initializing S3 Client with endpoint:', endpoint);

const s3Client = new S3Client({
    region: process.env.IDRIVE_REGION || 'ap-southeast-1',
    endpoint,
    credentials: {
        accessKeyId: process.env.IDRIVE_ACCESS_KEY,
        secretAccessKey: process.env.IDRIVE_SECRET_KEY,
    },
    // iDrive e2 and most S3-compatible stores require path-style signing for presigned URLs.
    forcePathStyle: true,
});

export const bucketName = process.env.IDRIVE_BUCKET_NAME;

export default s3Client;
