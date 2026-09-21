/**
 * One permission row per ERP inbox / email event.
 * Defaults are all ON. Keys are stable — do not rename after go-live.
 */

function row({ key, label, hint, detail, types, emailTypes }) {
    return {
        key,
        label,
        hint,
        detail,
        dashboardTypes: types || [],
        emailTypes: emailTypes || [],
    };
}

const detail = (type, extra = '') =>
    `Inbox, email, and WhatsApp for “${type}”. Email goes only if Email is on. WhatsApp is paid: company email gets one email (no WhatsApp, no extra HOD copy); no company email gets one WhatsApp. ${extra}`.trim();

export const NOTIFICATION_EMAIL_CATALOG = [
    {
        group: 'HRM',
        modules: [
            {
                module: 'Company',
                items: [
                    row({
                        key: 'hrm.company.activation',
                        label: 'Company activation',
                        hint: 'New company waiting activation.',
                        detail: detail('Company Activation'),
                        types: ['Company Activation'],
                        emailTypes: ['CompanyActivation'],
                    }),
                    row({
                        key: 'hrm.company.activation_incomplete',
                        label: 'Company activation incomplete',
                        hint: 'Required company cards still missing.',
                        detail: detail('Company Activation Incomplete'),
                        types: ['Company Activation Incomplete'],
                        emailTypes: ['CompanyActivationIncomplete'],
                    }),
                    row({
                        key: 'hrm.company.document_expiry',
                        label: 'Company document expiry reminder',
                        hint: 'Trade licence and company certificates (30 / 20 / 10 / 0 days).',
                        detail: detail('Document Expiry Reminder', 'Sent to Flowchart Admin Officer and HR.'),
                        types: ['Document Expiry Reminder'],
                        emailTypes: ['CompanyDocumentExpiry'],
                    }),
                    row({
                        key: 'hrm.company.document_not_renew',
                        label: 'Company document not renew',
                        hint: 'Company document marked not renew.',
                        detail: detail('Company Document Not Renew'),
                        types: ['Company Document Not Renew'],
                        emailTypes: ['CompanyDocumentNotRenew'],
                    }),
                ],
            },
            {
                module: 'Employees',
                items: [
                    row({
                        key: 'hrm.employees.profile_activation',
                        label: 'Profile activation request',
                        hint: 'Employee profile sent for HR activation.',
                        detail: detail('Profile Activation'),
                        types: ['Profile Activation'],
                        emailTypes: ['ProfileActivation'],
                    }),
                    row({
                        key: 'hrm.employees.profile_incomplete',
                        label: 'Mandatory cards incomplete',
                        hint: 'Required employee cards still missing.',
                        detail: detail('Profile Incomplete'),
                        types: ['Profile Incomplete'],
                        emailTypes: ['ProfileIncomplete'],
                    }),
                    row({
                        key: 'hrm.employees.document_expiry',
                        label: 'Employee document expiry reminder',
                        hint: 'Passport, visa, Emirates ID, labour card, insurance, licence, contract.',
                        detail: detail(
                            'Employee Document Expiry Reminder',
                            'HR follow-up stays in the inbox. Paid message: one email to the employee company email, or one WhatsApp if none.',
                        ),
                        types: ['Employee Document Expiry Reminder'],
                        emailTypes: ['EmployeeDocumentExpiry'],
                    }),
                    row({
                        key: 'hrm.employees.document_not_renew',
                        label: 'Employee document not renew',
                        hint: 'HR chose not to renew an expiring document.',
                        detail: detail('Employee Document Not Renew'),
                        types: ['Employee Document Not Renew'],
                        emailTypes: ['EmployeeDocumentNotRenew'],
                    }),
                    row({
                        key: 'hrm.employees.probation',
                        label: 'Probation change',
                        hint: 'Probation ending or change request.',
                        detail: detail('Probation Change'),
                        types: ['Probation Change'],
                        emailTypes: ['ProbationChange'],
                    }),
                    row({
                        key: 'hrm.employees.left_user',
                        label: 'Left user request',
                        hint: 'Employee marked Left User, pending HR.',
                        detail: detail('Left User Request'),
                        types: ['Left User Request'],
                        emailTypes: ['LeftUserRequest'],
                    }),
                    row({
                        key: 'hrm.employees.notice_request',
                        label: 'Notice request',
                        hint: 'Employee notice / warning request.',
                        detail: detail('Notice Request'),
                        types: ['Notice Request'],
                        emailTypes: ['NoticeRequest'],
                    }),
                    row({
                        key: 'hrm.employees.card_deleted',
                        label: 'Card deleted progress',
                        hint: 'A profile card was deleted and progress must continue.',
                        detail: detail('Card Deleted Progress'),
                        types: ['Card Deleted Progress'],
                        emailTypes: ['CardDeletedProgress'],
                    }),
                    row({
                        key: 'hrm.employees.certificate_request',
                        label: 'Employee certificate request',
                        hint: 'Certificate requested from employee hub.',
                        detail: detail('Employee Certificate Request'),
                        types: ['Employee Certificate Request'],
                        emailTypes: ['EmployeeCertificateRequest'],
                    }),
                    row({
                        key: 'hrm.employees.birthday',
                        label: 'Birthday wish',
                        hint: 'Birthday greeting (email / WhatsApp).',
                        detail: detail('Birthday wish', 'No inbox row. One paid message only.'),
                        types: [],
                        emailTypes: ['BirthdayWish'],
                    }),
                ],
            },
            {
                module: 'Attendance',
                items: [
                    row({
                        key: 'hrm.attendance.request',
                        label: 'Attendance leave request',
                        hint: 'Attendance-side leave / request pending.',
                        detail: detail('Attendance Leave Request'),
                        types: ['Attendance Leave Request'],
                        emailTypes: ['AttendanceLeaveRequest'],
                    }),
                ],
            },
            {
                module: 'Leave',
                items: [
                    row({
                        key: 'hrm.leave.request',
                        label: 'Employee leave request',
                        hint: 'Annual / other leave pending approval.',
                        detail: detail('Employee Leave Request'),
                        types: ['Employee Leave Request'],
                        emailTypes: ['EmployeeLeaveRequest'],
                    }),
                ],
            },
            {
                module: 'Salary',
                items: [
                    row({
                        key: 'hrm.salary.enrollment',
                        label: 'Salary enrollment',
                        hint: 'Salary profile sent for HR.',
                        detail: detail('Salary Enrollment'),
                        types: ['Salary Enrollment'],
                        emailTypes: ['SalaryEnrollment'],
                    }),
                    row({
                        key: 'hrm.salary.dmf',
                        label: 'Salary DMF approval',
                        hint: 'Salary DMF waiting approval.',
                        detail: detail('Salary DMF Approval'),
                        types: ['Salary DMF Approval'],
                        emailTypes: ['SalaryDmfApproval'],
                    }),
                    row({
                        key: 'hrm.salary.employee_request',
                        label: 'Employee salary request',
                        hint: 'Salary request from employee hub.',
                        detail: detail('Employee Salary Request'),
                        types: ['Employee Salary Request'],
                        emailTypes: ['EmployeeSalaryRequest'],
                    }),
                    row({
                        key: 'hrm.salary.process_reminder',
                        label: 'Salary process reminder',
                        hint: 'Scheduled salary process reminder.',
                        detail: detail('Salary process reminder', 'Scheduled job. One email per cycle.'),
                        types: [],
                        emailTypes: ['SalaryProcessReminder', 'SalaryMonthApproved'],
                    }),
                ],
            },
            {
                module: 'Fine',
                items: [
                    row({
                        key: 'hrm.fine.request',
                        label: 'Fine',
                        hint: 'Fine waiting review / pay.',
                        detail: detail('Fine'),
                        types: ['Fine'],
                        emailTypes: ['Fine', 'FineConfirmed', 'FineAccounts'],
                    }),
                    row({
                        key: 'hrm.fine.group',
                        label: 'Group fine request',
                        hint: 'Group fine pending.',
                        detail: detail('Group Fine Request'),
                        types: ['Group Fine Request'],
                        emailTypes: ['GroupFineRequest'],
                    }),
                    row({
                        key: 'hrm.fine.employee_request',
                        label: 'Employee fine request',
                        hint: 'Fine requested from employee hub.',
                        detail: detail('Employee Fine Request'),
                        types: ['Employee Fine Request'],
                        emailTypes: ['EmployeeFineRequest'],
                    }),
                ],
            },
            {
                module: 'Loan and Advance',
                items: [
                    row({
                        key: 'hrm.loan.request',
                        label: 'Loan',
                        hint: 'Loan waiting approval.',
                        detail: detail('Loan'),
                        types: ['Loan', 'Loan Request', 'Loan/Advance'],
                        emailTypes: ['Loan', 'LoanRequest'],
                    }),
                    row({
                        key: 'hrm.loan.advance',
                        label: 'Advance',
                        hint: 'Advance waiting approval.',
                        detail: detail('Advance'),
                        types: ['Advance'],
                        emailTypes: ['Advance'],
                    }),
                    row({
                        key: 'hrm.loan.employee_advance',
                        label: 'Employee advance request',
                        hint: 'Advance from employee hub.',
                        detail: detail('Employee Advance Request'),
                        types: ['Employee Advance Request'],
                        emailTypes: ['EmployeeAdvanceRequest'],
                    }),
                    row({
                        key: 'hrm.loan.employee_loan',
                        label: 'Employee loan request',
                        hint: 'Loan from employee hub.',
                        detail: detail('Employee Loan Request'),
                        types: ['Employee Loan Request'],
                        emailTypes: ['EmployeeLoanRequest'],
                    }),
                    row({
                        key: 'hrm.loan.approved',
                        label: 'Loan approved',
                        hint: 'WhatsApp when a loan is approved. If the employee has a WhatsApp number, the acknowledgment PDF is sent on WhatsApp instead of email.',
                        detail: 'When a loan is fully approved, the employee receives the acknowledgment PDF on WhatsApp if this is on and they have a WhatsApp number. If they have no WhatsApp number, they still get email.',
                        types: ['Loan Approved'],
                        emailTypes: ['LoanApproved'],
                    }),
                    row({
                        key: 'hrm.loan.advance_approved',
                        label: 'Advance approved',
                        hint: 'WhatsApp when an advance is approved. If the employee has a WhatsApp number, the acknowledgment PDF is sent on WhatsApp instead of email.',
                        detail: 'When an advance is fully approved, the employee receives the acknowledgment PDF on WhatsApp if this is on and they have a WhatsApp number. If they have no WhatsApp number, they still get email.',
                        types: ['Advance Approved'],
                        emailTypes: ['AdvanceApproved'],
                    }),
                ],
            },
            {
                module: 'Reward',
                items: [
                    row({
                        key: 'hrm.reward.request',
                        label: 'Reward',
                        hint: 'Reward waiting approval.',
                        detail: detail('Reward'),
                        types: ['Reward'],
                        emailTypes: ['Reward'],
                    }),
                ],
            },
            {
                module: 'Tools Asset',
                items: [
                    row({
                        key: 'hrm.tools.asset',
                        label: 'Asset',
                        hint: 'General tools asset inbox item.',
                        detail: detail('Asset'),
                        types: ['Asset'],
                        emailTypes: ['Asset'],
                    }),
                    row({
                        key: 'hrm.tools.approval',
                        label: 'Asset approval',
                        hint: 'New / edited asset waiting approval.',
                        detail: detail('Asset Approval'),
                        types: ['Asset Approval'],
                        emailTypes: ['AssetApproval'],
                    }),
                    row({
                        key: 'hrm.tools.assignment',
                        label: 'Asset assignment',
                        hint: 'Assign / handover waiting action.',
                        detail: detail('Asset Assignment'),
                        types: ['Asset Assignment'],
                        emailTypes: ['AssetAssignment'],
                    }),
                    row({
                        key: 'hrm.tools.transfer',
                        label: 'Asset transfer',
                        hint: 'Transfer between employees.',
                        detail: detail('Asset Transfer'),
                        types: ['Asset Transfer'],
                        emailTypes: ['AssetTransfer'],
                    }),
                    row({
                        key: 'hrm.tools.return',
                        label: 'Asset return',
                        hint: 'Return of assigned asset.',
                        detail: detail('Asset Return'),
                        types: ['Asset Return'],
                        emailTypes: ['AssetReturn'],
                    }),
                    row({
                        key: 'hrm.tools.loss_damage',
                        label: 'Asset loss / damage',
                        hint: 'Loss or damage report.',
                        detail: detail('Asset Loss Damage'),
                        types: ['Asset Loss Damage'],
                        emailTypes: ['AssetLossDamage'],
                    }),
                    row({
                        key: 'hrm.tools.end_of_life',
                        label: 'Asset end of life',
                        hint: 'Asset marked end of life.',
                        detail: detail('Asset End of Life'),
                        types: ['Asset End of Life'],
                        emailTypes: ['AssetEndOfLife'],
                    }),
                    row({
                        key: 'hrm.tools.overdue',
                        label: 'Asset overdue',
                        hint: 'Assigned asset overdue.',
                        detail: detail('Asset Overdue'),
                        types: ['Asset Overdue'],
                        emailTypes: ['AssetOverdue'],
                    }),
                    row({
                        key: 'hrm.tools.leave',
                        label: 'Asset leave',
                        hint: 'Asset while employee is on leave.',
                        detail: detail('Asset Leave'),
                        types: ['Asset Leave'],
                        emailTypes: ['AssetLeave'],
                    }),
                    row({
                        key: 'hrm.tools.owner_on_duty',
                        label: 'Asset owner on duty',
                        hint: 'Owner on-duty request.',
                        detail: detail('Asset Owner On Duty'),
                        types: ['Asset Owner On Duty'],
                        emailTypes: ['AssetOwnerOnDuty'],
                    }),
                    row({
                        key: 'hrm.tools.on_duty_request',
                        label: 'Asset on duty request',
                        hint: 'On-duty coverage request.',
                        detail: detail('Asset On Duty Request'),
                        types: ['Asset On Duty Request'],
                        emailTypes: ['AssetOnDutyRequest'],
                    }),
                    row({
                        key: 'hrm.tools.bulk_action',
                        label: 'Asset bulk action',
                        hint: 'Bulk assign / acknowledge.',
                        detail: detail('Asset Bulk Action'),
                        types: ['Asset Bulk Action'],
                        emailTypes: ['AssetBulkAction'],
                    }),
                    row({
                        key: 'hrm.tools.accessory',
                        label: 'Asset accessory',
                        hint: 'Accessory attach request.',
                        detail: detail('Asset Accessory'),
                        types: ['Asset Accessory'],
                        emailTypes: ['AssetAccessory'],
                    }),
                    row({
                        key: 'hrm.tools.accessory_approval',
                        label: 'Asset accessory approval',
                        hint: 'Accessory waiting approval.',
                        detail: detail('Asset Accessory Approval'),
                        types: ['Asset Accessory Approval'],
                        emailTypes: ['AssetAccessoryApproval'],
                    }),
                    row({
                        key: 'hrm.tools.accessory_unattach',
                        label: 'Asset accessory unattach',
                        hint: 'Accessory remove request.',
                        detail: detail('Asset Accessory Unattach'),
                        types: ['Asset Accessory Unattach'],
                        emailTypes: ['AssetAccessoryUnattach'],
                    }),
                    row({
                        key: 'hrm.tools.employee_request',
                        label: 'Employee asset request',
                        hint: 'Tools request from employee hub.',
                        detail: detail('Employee Asset Request'),
                        types: ['Employee Asset Request'],
                        emailTypes: ['EmployeeHub', 'EmployeeAssetRequest'],
                    }),
                    row({
                        key: 'hrm.tools.reassign',
                        label: 'Asset reassign',
                        hint: 'Reassignment between holders.',
                        detail: detail('Asset Reassign'),
                        types: ['Asset Reassign'],
                        emailTypes: ['AssetReassign'],
                    }),
                    row({
                        key: 'hrm.tools.retention',
                        label: 'Asset retention',
                        hint: 'Keep / retention decision.',
                        detail: detail('Asset Retention'),
                        types: ['Asset Retention'],
                        emailTypes: ['AssetRetention'],
                    }),
                    row({
                        key: 'hrm.tools.handover_report',
                        label: 'Tools handover report',
                        hint: 'WhatsApp when a tools handover report is sent.',
                        detail: detail('Tools Handover Report'),
                        types: ['Tools Handover Report'],
                        emailTypes: ['ToolsHandoverReport'],
                    }),
                    row({
                        key: 'hrm.tools.monthly_report',
                        label: 'Tools monthly report',
                        hint: 'WhatsApp when a tools monthly report is sent.',
                        detail: detail('Tools Monthly Report'),
                        types: ['Tools Monthly Report'],
                        emailTypes: ['ToolsMonthlyReport'],
                    }),
                ],
            },
            {
                module: 'Vehicle Asset',
                items: [
                    row({
                        key: 'hrm.vehicle.service',
                        label: 'Vehicle service request',
                        hint: 'Garage / service job pending.',
                        detail: detail('Vehicle Service Request'),
                        types: ['Vehicle Service Request'],
                        emailTypes: ['VehicleService'],
                    }),
                    row({
                        key: 'hrm.vehicle.profile_activation',
                        label: 'Vehicle profile activation',
                        hint: 'New vehicle waiting activation.',
                        detail: detail('Vehicle Profile Activation'),
                        types: ['Vehicle Profile Activation'],
                        emailTypes: ['VehicleProfileActivation'],
                    }),
                    row({
                        key: 'hrm.vehicle.profile_edit',
                        label: 'Vehicle profile edit',
                        hint: 'Vehicle edit waiting approval.',
                        detail: detail('Vehicle Profile Edit'),
                        types: ['Vehicle Profile Edit'],
                        emailTypes: ['VehicleProfileEdit'],
                    }),
                    row({
                        key: 'hrm.vehicle.profile_incomplete',
                        label: 'Vehicle profile incomplete',
                        hint: 'Required vehicle cards missing.',
                        detail: detail('Vehicle Profile Incomplete'),
                        types: ['Vehicle Profile Incomplete'],
                        emailTypes: ['VehicleProfileIncomplete'],
                    }),
                    row({
                        key: 'hrm.vehicle.inspection',
                        label: 'Vehicle inspection',
                        hint: 'First / scheduled inspection.',
                        detail: detail('Vehicle Inspection'),
                        types: ['Vehicle Inspection'],
                        emailTypes: ['VehicleInspection'],
                    }),
                    row({
                        key: 'hrm.vehicle.assignment_photo',
                        label: 'Vehicle assignment photo review',
                        hint: 'Handover photos waiting review.',
                        detail: detail('Vehicle Assignment Photo Review'),
                        types: ['Vehicle Assignment Photo Review'],
                        emailTypes: ['VehicleAssignmentPhotoReview'],
                    }),
                    row({
                        key: 'hrm.vehicle.handover',
                        label: 'Vehicle handover',
                        hint: 'WhatsApp when a vehicle handover message is sent. If unchecked, company email is used.',
                        detail: detail('Vehicle Handover'),
                        types: ['Vehicle Handover'],
                        emailTypes: ['VehicleHandover'],
                    }),
                    row({
                        key: 'hrm.vehicle.mortgage_close',
                        label: 'Vehicle mortgage close',
                        hint: 'Mortgage close request.',
                        detail: detail('Vehicle Mortgage Close'),
                        types: ['Vehicle Mortgage Close'],
                        emailTypes: ['VehicleMortgageClose'],
                    }),
                    row({
                        key: 'hrm.vehicle.disposition',
                        label: 'Vehicle disposition request',
                        hint: 'Sell / dispose vehicle.',
                        detail: detail('Vehicle Disposition Request'),
                        types: ['Vehicle Disposition Request'],
                        emailTypes: ['VehicleDispositionRequest'],
                    }),
                    row({
                        key: 'hrm.vehicle.delete',
                        label: 'Vehicle delete request',
                        hint: 'Delete vehicle profile.',
                        detail: detail('Vehicle Delete Request'),
                        types: ['Vehicle Delete Request'],
                        emailTypes: ['VehicleDeleteRequest'],
                    }),
                    row({
                        key: 'hrm.vehicle.document_expiry',
                        label: 'Vehicle document expiry',
                        hint: 'Mulkiya, insurance, and other vehicle docs.',
                        detail: detail('Vehicle Document Expiry Reminder'),
                        types: ['Vehicle Document Expiry Reminder'],
                        emailTypes: ['VehicleDocumentExpiry'],
                    }),
                    row({
                        key: 'hrm.vehicle.access_fuel',
                        label: 'Vehicle access fuel reminder',
                        hint: 'Fuel / access reminder.',
                        detail: detail('Vehicle Access Fuel Reminder'),
                        types: ['Vehicle Access Fuel Reminder'],
                        emailTypes: ['VehicleAccessFuelReminder', 'VehicleFuel'],
                    }),
                    row({
                        key: 'hrm.vehicle.employee_request',
                        label: 'Employee vehicle request',
                        hint: 'Vehicle request from employee hub.',
                        detail: detail('Employee Vehicle Request'),
                        types: ['Employee Vehicle Request'],
                        emailTypes: ['EmployeeVehicleRequest'],
                    }),
                ],
            },
            {
                module: 'Utility Bills',
                items: [
                    row({
                        key: 'hrm.utility.bill_payment',
                        label: 'Utility bill payment',
                        hint: 'Bill review / pay.',
                        detail: detail('Utility Bill Payment'),
                        types: ['Utility Bill Payment'],
                        emailTypes: ['UtilityBillPayment'],
                    }),
                    row({
                        key: 'hrm.utility.payment_reminder',
                        label: 'Utility bill payment reminder',
                        hint: 'Payment-day reminder.',
                        detail: detail('Utility Bill Payment Reminder'),
                        types: ['Utility Bill Payment Reminder'],
                        emailTypes: ['UtilityBillPaymentReminder'],
                    }),
                    row({
                        key: 'hrm.utility.contract_expiry',
                        label: 'Utility contract expiry',
                        hint: 'SIM / contract near expiry.',
                        detail: detail('Utility Contract Expiry'),
                        types: ['Utility Contract Expiry'],
                        emailTypes: ['UtilityContractExpiry'],
                    }),
                    row({
                        key: 'hrm.utility.status_change',
                        label: 'Utility entry status change',
                        hint: 'Active / inactive change on a utility account.',
                        detail: detail('Utility Entry Status Change'),
                        types: ['Utility Entry Status Change'],
                        emailTypes: ['UtilityEntryStatusChange'],
                    }),
                    row({
                        key: 'hrm.utility.employee_request',
                        label: 'Employee utility request',
                        hint: 'Utility request from employee hub.',
                        detail: detail('Employee Utility Request'),
                        types: ['Employee Utility Request'],
                        emailTypes: ['EmployeeUtilityRequest'],
                    }),
                ],
            },
        ],
    },
    {
        group: 'Accounts',
        modules: [
            {
                module: 'Payments',
                items: [
                    row({
                        key: 'accounts.payments.approval',
                        label: 'Payment approval',
                        hint: 'Payment waiting Accounts / approver.',
                        detail: detail('Payment Approval'),
                        types: ['Payment Approval'],
                        emailTypes: ['PaymentApproval'],
                    }),
                ],
            },
        ],
    },
    {
        group: 'Settings',
        modules: [
            {
                module: 'Flowchart',
                items: [
                    row({
                        key: 'settings.flowchart.responsibility',
                        label: 'Responsibility approval',
                        hint: 'Flowchart responsibility acceptance.',
                        detail: detail('Responsibility Approval'),
                        types: ['Responsibility Approval'],
                        emailTypes: ['ResponsibilityApproval'],
                    }),
                ],
            },
        ],
    },
];

const TYPE_TO_KEY = new Map();
const EMAIL_TYPE_TO_KEY = new Map();

for (const group of NOTIFICATION_EMAIL_CATALOG) {
    for (const mod of group.modules) {
        for (const item of mod.items) {
            for (const type of item.dashboardTypes || []) {
                TYPE_TO_KEY.set(String(type).trim(), item.key);
            }
            for (const type of item.emailTypes || []) {
                EMAIL_TYPE_TO_KEY.set(String(type).trim(), item.key);
            }
        }
    }
}

export function eventKeyForDashboardType(type) {
    return TYPE_TO_KEY.get(String(type || '').trim()) || '';
}

export function eventKeyForEmailType(emailType) {
    return EMAIL_TYPE_TO_KEY.get(String(emailType || '').trim()) || '';
}

/** Settings → WhatsApp Permission page shows only these events. */
export const WHATSAPP_PERMISSION_PAGE_KEYS = [
    'hrm.loan.approved',
    'hrm.loan.advance_approved',
    'hrm.tools.handover_report',
    'hrm.tools.monthly_report',
    'hrm.vehicle.handover',
];

export function flattenWhatsAppPermissionPageCatalog() {
    return flattenNotificationEmailCatalog().filter((item) =>
        WHATSAPP_PERMISSION_PAGE_KEYS.includes(item.key),
    );
}

export function flattenNotificationEmailCatalog() {
    const items = [];
    for (const group of NOTIFICATION_EMAIL_CATALOG) {
        for (const mod of group.modules) {
            for (const item of mod.items) {
                items.push({
                    ...item,
                    group: group.group,
                    module: mod.module,
                });
            }
        }
    }
    return items;
}
