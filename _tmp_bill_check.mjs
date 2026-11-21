import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(dir, '.env') });
await mongoose.connect(process.env.MONGO_URI);
const names = (await mongoose.connection.db.listCollections().toArray()).map((row) => row.name).filter((name) => /stock|invent|bill/i.test(name));
console.log('COLS', names.join(', '));
const col = mongoose.connection.collection(names.find((name) => /stockentry/i.test(name)) || 'inventorystockentries');
const itemId = '6afc61f078f6fe71efde9062';
const total = await col.countDocuments();
const statuses = await col.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
console.log('TOTAL', total, JSON.stringify(statuses));
const sample = await col.find({}).sort({ updatedAt: -1 }).limit(6).project({
    purchaseSource: 1, billNo: 1, status: 1, 'lines.itemId': 1, 'lines.itemName': 1, 'lines.quantity': 1, 'lines.unitPrice': 1,
}).toArray();
console.log('SAMPLE', JSON.stringify(sample.map((row) => ({
    id: String(row._id),
    source: row.purchaseSource,
    billNo: row.billNo,
    status: row.status,
    lines: (row.lines || []).map((line) => ({ id: String(line.itemId || ''), name: line.itemName, qty: line.quantity, price: line.unitPrice })),
})), null, 2));
const rows = await col.find({
    'lines.itemId': { $in: [new mongoose.Types.ObjectId(itemId), itemId] },
}).project({
    purchaseSource: 1,
    billNo: 1,
    vendorId: 1,
    purchaseDate: 1,
    status: 1,
    postedAt: 1,
    'lines.itemId': 1,
    'lines.quantity': 1,
    'lines.unitPrice': 1,
    'lines.itemName': 1,
}).toArray();
console.log(JSON.stringify(rows.map((row) => ({
    id: String(row._id),
    source: row.purchaseSource,
    billNo: row.billNo,
    status: row.status,
    date: row.purchaseDate,
    postedAt: row.postedAt,
    lines: (row.lines || []).filter((line) => String(line.itemId) === itemId).map((line) => ({
        qty: line.quantity,
        price: line.unitPrice,
        name: line.itemName,
    })),
})), null, 2));
const recent = await col.find({ status: 'posted' }).sort({ postedAt: -1 }).limit(8).project({
    purchaseSource: 1,
    billNo: 1,
    status: 1,
    postedAt: 1,
}).toArray();
console.log('RECENT', JSON.stringify(recent.map((row) => ({
    id: String(row._id),
    source: row.purchaseSource,
    billNo: row.billNo,
    status: row.status,
})), null, 2));
await mongoose.disconnect();
