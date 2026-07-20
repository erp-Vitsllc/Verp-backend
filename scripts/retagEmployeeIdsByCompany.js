/**
 * Retag existing employee IDs by company (VEGA-HR- / NNIT-HR-).
 *
 * Keeps the trailing number; only swaps the prefix from company name rules
 * (see utils/employeeIdPrefix.js). Skips collisions and placeholders.
 *
 * ---------------------------------------------------------------------------
 * RUNBOOK
 * ---------------------------------------------------------------------------
 * 1. Backup MongoDB (and note S3/IDrive bucket).
 * 2. From VERP_backend:
 *      node scripts/retagEmployeeIdsByCompany.js
 *    (dry-run by default — prints planned renames / conflicts)
 * 3. Review the report, especially status=conflict rows.
 * 4. Apply:
 *      node scripts/retagEmployeeIdsByCompany.js --apply
 *    Optional: --skip-s3  (DB only; leave object keys under old prefix)
 * 5. Spot-check:
 *    - Login as a retagged user
 *    - Open employee profile (documents load)
 *    - One Fine / Reward / Loan for that employee
 *    - Dashboard inbox rows (assignedToEmpId / subjectEmployeeId)
 *    - Add Employee → next ID for a Vega company and an NNIT company
 *
 * npm:  npm run retag-employee-ids
 *       npm run retag-employee-ids -- --apply
 * ---------------------------------------------------------------------------
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { connectDB } from '../config/db.js';
import s3Client, { bucketName } from '../config/s3Client.js';
import { copyS3Object, normalizeS3Key } from '../utils/s3Upload.js';
import {
    buildRetaggedEmployeeId,
    isPlaceholderEmployeeId,
} from '../utils/employeeIdPrefix.js';

import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeContact from '../models/EmployeeContact.js';
import EmployeePersonal from '../models/EmployeePersonal.js';
import EmployeeBank from '../models/EmployeeBank.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import EmployeePassport from '../models/EmployeePassport.js';
import EmployeeVisa from '../models/EmployeeVisa.js';
import EmployeeEmiratesId from '../models/EmployeeEmiratesId.js';
import EmployeeMedicalInsurance from '../models/EmployeeMedicalInsurance.js';
import EmployeeDrivingLicense from '../models/EmployeeDrivingLicense.js';
import EmployeeLabourCard from '../models/EmployeeLabourCard.js';
import EmployeeEducation from '../models/EmployeeEducation.js';
import EmployeeExperience from '../models/EmployeeExperience.js';
import EmployeeTraining from '../models/EmployeeTraining.js';
import EmployeeEmergencyContact from '../models/EmployeeEmergencyContact.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Fine from '../models/Fine.js';
import Reward from '../models/Reward.js';
import Loan from '../models/Loan.js';
import BirthdayReminderLog from '../models/BirthdayReminderLog.js';
import Flowchart from '../models/Flowchart.js';
import Company from '../models/Company.js';
import DashboardAction from '../models/DashboardAction.js';
import AdminDeletionArchive from '../models/AdminDeletionArchive.js';

dotenv.config({ path: '.env' });

const APPLY = process.argv.includes('--apply');
const SKIP_S3 = process.argv.includes('--skip-s3');
const DRY_RUN = !APPLY;

const EMPLOYEE_ID_MODELS = [
    EmployeeBasic,
    EmployeeContact,
    EmployeePersonal,
    EmployeeBank,
    EmployeeSalary,
    EmployeePassport,
    EmployeeVisa,
    EmployeeEmiratesId,
    EmployeeMedicalInsurance,
    EmployeeDrivingLicense,
    EmployeeLabourCard,
    EmployeeEducation,
    EmployeeExperience,
    EmployeeTraining,
    EmployeeEmergencyContact,
    Employee,
    User,
    Reward,
    Loan,
    BirthdayReminderLog,
    Flowchart,
];

function pad(status, width = 10) {
    return String(status).padEnd(width);
}

/**
 * Deep-replace string values that contain oldId / old document path with newId.
 * Mutates a plain object tree (lean doc). Returns whether anything changed.
 */
function replaceIdInValueTree(value, oldId, newId) {
    const oldPath = `employee-documents/${oldId}`;
    const newPath = `employee-documents/${newId}`;
    let changed = false;

    const walk = (node) => {
        if (node == null) return node;
        if (typeof node === 'string') {
            let next = node;
            if (next.includes(oldPath)) {
                next = next.split(oldPath).join(newPath);
                changed = true;
            }
            if (next === oldId) {
                next = newId;
                changed = true;
            } else if (next.includes(oldId) && /employee-documents|employee-profiles|employee-signatures/i.test(next)) {
                next = next.split(oldId).join(newId);
                changed = true;
            }
            return next;
        }
        if (Array.isArray(node)) {
            return node.map(walk);
        }
        if (typeof node === 'object') {
            // Leave ObjectId / Date alone
            if (node instanceof mongoose.Types.ObjectId || node instanceof Date || Buffer.isBuffer(node)) {
                return node;
            }
            if (node._bsontype === 'ObjectID' || node._bsontype === 'ObjectId') {
                return node;
            }
            const out = {};
            for (const [key, child] of Object.entries(node)) {
                if (key === '_id' || key === 'id') {
                    out[key] = child;
                    continue;
                }
                out[key] = walk(child);
            }
            return out;
        }
        return node;
    };

    const result = walk(value);
    return { value: result, changed };
}

async function rewriteAttachmentPathsForEmployee(oldId, newId) {
    const models = [
        EmployeeBasic,
        EmployeeContact,
        EmployeePersonal,
        EmployeeBank,
        EmployeeSalary,
        EmployeePassport,
        EmployeeVisa,
        EmployeeEmiratesId,
        EmployeeMedicalInsurance,
        EmployeeDrivingLicense,
        EmployeeLabourCard,
        EmployeeEducation,
        EmployeeExperience,
        EmployeeTraining,
        EmployeeEmergencyContact,
    ];

    let docsUpdated = 0;
    for (const Model of models) {
        const docs = await Model.find({ employeeId: newId }).lean();
        for (const doc of docs) {
            const { value, changed } = replaceIdInValueTree(doc, oldId, newId);
            if (!changed) continue;
            const { _id, ...rest } = value;
            await Model.updateOne({ _id }, { $set: rest });
            docsUpdated += 1;
        }
    }
    return docsUpdated;
}

/**
 * Copy S3 objects under employee-documents/{oldId}/ to {newId}/.
 * Returns { copied, warnings }.
 */
async function renameEmployeeDocumentPrefix(oldId, newId) {
    const result = { copied: 0, deleted: 0, warnings: [] };
    if (!bucketName) {
        result.warnings.push('S3 bucket not configured; skipped object rename.');
        return result;
    }

    const prefix = `employee-documents/${oldId}/`;
    const keys = new Set();

    try {
        let continuationToken;
        do {
            const response = await s3Client.send(
                new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
            );
            for (const obj of response.Contents || []) {
                if (obj.Key) keys.add(obj.Key);
            }
            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;
        } while (continuationToken);
    } catch (err) {
        result.warnings.push(`S3 list failed: ${err?.message || err}`);
        return result;
    }

    if (!keys.size) {
        return result;
    }

    for (const sourceKey of keys) {
        const destKey = sourceKey.split(`employee-documents/${oldId}`).join(
            `employee-documents/${newId}`,
        );
        if (destKey === sourceKey) continue;
        try {
            await copyS3Object(sourceKey, destKey);
            result.copied += 1;
            try {
                await s3Client.send(
                    new DeleteObjectCommand({
                        Bucket: bucketName,
                        Key: normalizeS3Key(sourceKey) || sourceKey,
                    }),
                );
                result.deleted += 1;
            } catch (delErr) {
                result.warnings.push(
                    `Copied ${sourceKey} but delete failed: ${delErr?.message || delErr}`,
                );
            }
        } catch (copyErr) {
            result.warnings.push(
                `Copy failed ${sourceKey} → ${destKey}: ${copyErr?.message || copyErr}`,
            );
        }
    }

    return result;
}

async function updateEmployeeIdEverywhere(oldId, newId) {
    const counts = {};

    for (const Model of EMPLOYEE_ID_MODELS) {
        const name = Model.modelName;
        const res = await Model.updateMany({ employeeId: oldId }, { $set: { employeeId: newId } });
        counts[name] = res.modifiedCount || 0;
    }

    const fineRes = await Fine.updateMany(
        { 'assignedEmployees.employeeId': oldId },
        { $set: { 'assignedEmployees.$[elem].employeeId': newId } },
        { arrayFilters: [{ 'elem.employeeId': oldId }] },
    );
    counts.Fine = fineRes.modifiedCount || 0;

    const companyRes = await Company.updateMany(
        { 'responsibilities.employeeId': oldId },
        { $set: { 'responsibilities.$[elem].employeeId': newId } },
        { arrayFilters: [{ 'elem.employeeId': oldId }] },
    );
    counts.CompanyResponsibilities = companyRes.modifiedCount || 0;

    const dashAssigned = await DashboardAction.updateMany(
        { assignedToEmpId: oldId },
        { $set: { assignedToEmpId: newId } },
    );
    const dashSubject = await DashboardAction.updateMany(
        { subjectEmployeeId: oldId },
        { $set: { subjectEmployeeId: newId } },
    );
    counts.DashboardAction =
        (dashAssigned.modifiedCount || 0) + (dashSubject.modifiedCount || 0);

    try {
        const archiveRes = await AdminDeletionArchive.updateMany(
            { 'deletedBy.employeeId': oldId },
            { $set: { 'deletedBy.employeeId': newId } },
        );
        counts.AdminDeletionArchive = archiveRes.modifiedCount || 0;
    } catch {
        counts.AdminDeletionArchive = 0;
    }

    return counts;
}

async function employeeIdExists(employeeId) {
    const id = String(employeeId || '').trim();
    if (!id) return false;
    const [basic, user] = await Promise.all([
        EmployeeBasic.exists({ employeeId: id }),
        User.exists({ employeeId: id }),
    ]);
    return Boolean(basic || user);
}

async function main() {
    console.log(
        `\nRetag employee IDs by company — mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}${
            SKIP_S3 ? ' (skip S3)' : ''
        }\n`,
    );

    await connectDB();

    const employees = await EmployeeBasic.find({})
        .populate('company', 'name nickName')
        .select('employeeId firstName lastName company')
        .lean();

    const report = [];
    let renamed = 0;
    let skipped = 0;
    let conflicts = 0;
    let errors = 0;

    // Pre-claim target IDs within this run to avoid two employees mapping to the same newId
    const claimedTargets = new Set();

    for (const emp of employees) {
        const oldId = String(emp.employeeId || '')
            .trim()
            .toUpperCase()
            .replace(/\s+/g, '');
        const companyName = emp.company?.name || emp.company?.nickName || '';
        const row = {
            oldId,
            newId: '',
            company: companyName || '(no company)',
            name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim(),
            status: 'skipped',
            detail: '',
        };

        if (!oldId) {
            row.detail = 'empty employeeId';
            skipped += 1;
            report.push(row);
            continue;
        }

        if (isPlaceholderEmployeeId(oldId)) {
            row.detail = 'placeholder company-party id';
            skipped += 1;
            report.push(row);
            continue;
        }

        if (!emp.company) {
            row.detail = 'no company linked';
            skipped += 1;
            report.push(row);
            continue;
        }

        const built = buildRetaggedEmployeeId(oldId, emp.company);
        if (!built) {
            row.detail = 'could not parse numeric suffix';
            skipped += 1;
            report.push(row);
            continue;
        }

        row.newId = built.newId;

        if (built.newId === oldId) {
            row.status = 'skipped';
            row.detail = 'already correct prefix';
            skipped += 1;
            report.push(row);
            continue;
        }

        if (claimedTargets.has(built.newId) || (await employeeIdExists(built.newId))) {
            row.status = 'conflict';
            row.detail = `target ${built.newId} already exists`;
            conflicts += 1;
            report.push(row);
            continue;
        }

        claimedTargets.add(built.newId);

        if (DRY_RUN) {
            row.status = 'would-rename';
            row.detail = `${built.prefix} + ${built.digits}`;
            renamed += 1;
            report.push(row);
            continue;
        }

        try {
            let s3Note = '';
            if (!SKIP_S3) {
                const s3 = await renameEmployeeDocumentPrefix(oldId, built.newId);
                if (s3.copied) {
                    s3Note = `s3 copied=${s3.copied} deleted=${s3.deleted}`;
                }
                if (s3.warnings.length) {
                    s3Note = [s3Note, ...s3.warnings].filter(Boolean).join('; ');
                    console.warn(`[S3] ${oldId} → ${built.newId}:`, s3.warnings.join(' | '));
                }
            }

            await updateEmployeeIdEverywhere(oldId, built.newId);
            const pathDocs = await rewriteAttachmentPathsForEmployee(oldId, built.newId);

            row.status = 'renamed';
            row.detail = [s3Note, pathDocs ? `pathDocs=${pathDocs}` : '']
                .filter(Boolean)
                .join('; ');
            renamed += 1;
            report.push(row);
        } catch (err) {
            claimedTargets.delete(built.newId);
            row.status = 'error';
            row.detail = err?.message || String(err);
            errors += 1;
            report.push(row);
            console.error(`[ERROR] ${oldId} → ${built.newId}:`, err);
        }
    }

    console.log('oldId'.padEnd(18), '→', 'newId'.padEnd(18), pad('status'), 'company / detail');
    console.log('-'.repeat(100));
    for (const row of report) {
        if (row.status === 'skipped' && row.detail === 'already correct prefix') {
            // Keep report quieter for no-ops unless verbose needed
            continue;
        }
        console.log(
            String(row.oldId).padEnd(18),
            '→',
            String(row.newId || '—').padEnd(18),
            pad(row.status),
            `${row.company}${row.detail ? ` | ${row.detail}` : ''}`,
        );
    }

    const skippedCorrect = report.filter(
        (r) => r.status === 'skipped' && r.detail === 'already correct prefix',
    ).length;

    console.log('\nSummary');
    console.log(`  total employees : ${employees.length}`);
    console.log(`  ${DRY_RUN ? 'would rename' : 'renamed'} : ${renamed}`);
    console.log(`  skipped (ok)    : ${skippedCorrect}`);
    console.log(`  skipped (other) : ${skipped - skippedCorrect}`);
    console.log(`  conflicts       : ${conflicts}`);
    console.log(`  errors          : ${errors}`);
    console.log(
        DRY_RUN
            ? '\nDry-run only. Re-run with --apply to write changes.\n'
            : '\nApply complete.\n',
    );

    await mongoose.connection.close();

    if (APPLY && (conflicts > 0 || errors > 0)) {
        process.exitCode = 1;
    }
}

main().catch(async (err) => {
    console.error('Fatal:', err);
    try {
        await mongoose.connection.close();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
