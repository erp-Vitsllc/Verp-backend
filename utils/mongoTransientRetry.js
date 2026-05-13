/**
 * True for network / pool / primary-election style failures where a short retry may succeed.
 */
export function isTransientMongoError(err) {
    if (!err) return false;
    const name = String(err.name || '');
    const msg = String(err.message || err || '');
    const combined = `${name} ${msg}`;
    return (
        /timed out/i.test(combined) ||
        /MongoNetwork/i.test(name) ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('PoolCleared') ||
        msg.includes('WaitQueueTimeout') ||
        msg.includes('wait queue') ||
        msg.includes('server selection') ||
        msg.includes('ReplicaSetNoPrimary') ||
        msg.includes('not primary') ||
        msg.includes('InterruptedAtShutdown')
    );
}
