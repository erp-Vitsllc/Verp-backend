import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Fine from '../models/Fine.js';
import { downloadS3ObjectBytes } from '../utils/s3Upload.js';

await connectDB();

const fine = await Fine.findOne({ fineId: /VEGA-Fine/i, fineStatus: 'Approved' }).sort({ updatedAt: -1 }).lean();
console.log('Fine:', fine?.fineId, 'emp:', fine?.assignedEmployees?.[0]);

const empId = fine?.assignedEmployees?.[0]?.employeeId;
if (empId) {
    const emp = await EmployeeBasic.findOne({ employeeId: empId }).select('firstName lastName signature').lean();
    console.log('Employee:', emp?.firstName, 'sig:', emp?.signature);
    if (emp?.signature) {
        const b = await downloadS3ObjectBytes(emp.signature.publicId || emp.signature.url);
        console.log('employee bytes', b?.length);
    }
}

const nesmi = await EmployeeBasic.findOne({ firstName: /nesmi/i }).select('employeeId firstName signature').lean();
console.log('NESMI:', nesmi?.employeeId, nesmi?.signature);
if (nesmi?.signature) {
    const b = await downloadS3ObjectBytes(nesmi.signature.publicId);
    console.log('nesmi bytes', b?.length);
}

const adarsh = await EmployeeBasic.findOne({ firstName: /adarsh/i }).select('employeeId firstName signature primaryReportee').populate('primaryReportee', 'firstName signature').lean();
console.log('Adarsh:', adarsh?.employeeId, 'sig:', !!adarsh?.signature?.publicId, 'hod:', adarsh?.primaryReportee?.firstName, 'hodSig:', !!adarsh?.primaryReportee?.signature?.publicId);

await mongoose.disconnect();
