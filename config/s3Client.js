import dns from 'dns';
import https from 'https';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
    getS3AccessKey,
    getS3BucketName,
    getS3Endpoint,
    getS3Region,
    getS3SecretKey,
} from './storageConfig.js';

/**
 * Windows/ISP DNS (e.g. EtisalatHub) can refuse Wasabi hostnames via getaddrinfo
 * (dns.lookup → ENOTFOUND) while dns.resolve4 against public DNS still works.
 * AWS SDK uses lookup by default — force resolve4 for S3 HTTPS connections.
 */
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

function storageDnsLookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    dns.resolve4(hostname, (err, addresses) => {
        if (!err && addresses?.length) {
            if (options?.all) {
                return callback(
                    null,
                    addresses.map((address) => ({ address, family: 4 })),
                );
            }
            return callback(null, addresses[0], 4);
        }
        return dns.lookup(hostname, options, callback);
    });
}

const endpoint = getS3Endpoint();

console.log('Initializing S3 Client with endpoint:', endpoint);

const httpsAgent = new https.Agent({
    keepAlive: true,
    lookup: storageDnsLookup,
});

const s3Client = new S3Client({
    region: getS3Region(),
    endpoint,
    credentials: {
        accessKeyId: getS3AccessKey(),
        secretAccessKey: getS3SecretKey(),
    },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
        httpsAgent,
        connectionTimeout: 15_000,
        requestTimeout: 120_000,
    }),
});

export const bucketName = getS3BucketName();

export default s3Client;
