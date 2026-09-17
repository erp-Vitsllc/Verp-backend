/**
 * Catalog of ERP notification / email / WhatsApp events.
 * Defaults are all ON so existing behaviour is unchanged until an admin unchecks a box.
 */

export const NOTIFICATION_EMAIL_CATALOG = [
    {
        group: 'HRM',
        modules: [
            {
                module: 'Employees',
                items: [
                    {
                        key: 'hrm.employees.document_expiry',
                        label: 'Employee document expiry reminder',
                        hint: 'Passport, visa, Emirates ID, labour card, insurance, licence, contract.',
                        detail:
                            'Sent at 30 / 20 / 10 / 0 days before an employee document expires. Inbox goes to Flowchart HR. Paid message: one email to the employee company email, or one WhatsApp if they have no company email. Never both. HOD is not copied when the employee has a company email.',
                        dashboardTypes: ['Employee Document Expiry Reminder'],
                        emailTypes: ['EmployeeDocumentExpiry'],
                    },
                    {
                        key: 'hrm.employees.profile_activation',
                        label: 'Profile activation request',
                        hint: 'HR review when a profile is submitted for activation.',
                        detail: 'Inbox and email when an employee profile is sent for HR activation approval.',
                        dashboardTypes: ['Profile Activation'],
                        emailTypes: ['ProfileActivation'],
                    },
                    {
                        key: 'hrm.employees.profile_incomplete',
                        label: 'Mandatory cards incomplete',
                        hint: 'Profile still missing required cards.',
                        detail: 'Inbox when required employee cards are still incomplete.',
                        dashboardTypes: ['Profile Incomplete'],
                        emailTypes: ['ProfileIncomplete'],
                    },
                    {
                        key: 'hrm.employees.probation',
                        label: 'Probation change',
                        hint: 'Probation ending or change request.',
                        detail: 'Inbox and email for probation workflow (end / change).',
                        dashboardTypes: ['Probation Change'],
                        emailTypes: ['ProbationChange'],
                    },
                    {
                        key: 'hrm.employees.left_user',
                        label: 'Left user request',
                        hint: 'Employee marked Left User pending HR.',
                        detail: 'Inbox when a Left User change needs HR review.',
                        dashboardTypes: ['Left User Request'],
                        emailTypes: ['LeftUserRequest'],
                    },
                    {
                        key: 'hrm.employees.document_not_renew',
                        label: 'Employee document not renew',
                        hint: 'HR chose not to renew an expiring document.',
                        detail: 'Inbox when an employee document is marked not renew.',
                        dashboardTypes: ['Employee Document Not Renew'],
                        emailTypes: ['EmployeeDocumentNotRenew'],
                    },
                    {
                        key: 'hrm.employees.birthday',
                        label: 'Birthday wish',
                        hint: 'Birthday greeting to the employee.',
                        detail: 'Email/WhatsApp birthday wish. One message only.',
                        dashboardTypes: [],
                        emailTypes: ['BirthdayWish'],
                    },
                    {
                        key: 'hrm.employees.hub_request',
                        label: 'Employee hub request',
                        hint: 'Asset / utility / other hub requests from the employee.',
                        detail: 'Emails and inbox for employee hub requests.',
                        dashboardTypes: [
                            'Employee Asset Request',
                            'Employee Vehicle Request',
                            'Employee Utility Request',
                        ],
                        emailTypes: ['EmployeeHub'],
                    },
                ],
            },
            {
                module: 'Company',
                items: [
                    {
                        key: 'hrm.company.document_expiry',
                        label: 'Company document expiry reminder',
                        hint: 'Trade licence and company certificates.',
                        detail: 'Reminder at 30 / 20 / 10 / 0 days. Inbox and email to Flowchart Admin Officer and HR.',
                        dashboardTypes: ['Document Expiry Reminder'],
                        emailTypes: ['CompanyDocumentExpiry'],
                    },
                    {
                        key: 'hrm.company.activation',
                        label: 'Company activation',
                        hint: 'Company profile activation / incomplete.',
                        detail: 'Inbox for company activation and incomplete company cards.',
                        dashboardTypes: ['Company Activation', 'Company Activation Incomplete'],
                        emailTypes: ['CompanyActivation'],
                    },
                    {
                        key: 'hrm.company.document_not_renew',
                        label: 'Company document not renew',
                        hint: 'Company document marked not renew.',
                        detail: 'Inbox when a company document is not renewed.',
                        dashboardTypes: ['Company Document Not Renew'],
                        emailTypes: ['CompanyDocumentNotRenew'],
                    },
                ],
            },
            {
                module: 'Attendance',
                items: [
                    {
                        key: 'hrm.attendance.request',
                        label: 'Attendance leave request',
                        hint: 'Attendance-side leave / request pending.',
                        detail: 'Inbox and email for attendance leave requests.',
                        dashboardTypes: ['Attendance Leave Request'],
                        emailTypes: ['AttendanceLeaveRequest'],
                    },
                ],
            },
            {
                module: 'Leave',
                items: [
                    {
                        key: 'hrm.leave.request',
                        label: 'Employee leave request',
                        hint: 'Annual / other leave pending approval.',
                        detail: 'Inbox and email for employee leave requests.',
                        dashboardTypes: ['Employee Leave Request'],
                        emailTypes: ['EmployeeLeaveRequest'],
                    },
                ],
            },
            {
                module: 'Salary',
                items: [
                    {
                        key: 'hrm.salary.enrollment',
                        label: 'Salary enrollment',
                        hint: 'Salary profile sent for HR / DMF.',
                        detail: 'Inbox and email for salary enrollment and DMF approval.',
                        dashboardTypes: ['Salary Enrollment', 'Salary DMF Approval'],
                        emailTypes: ['SalaryEnrollment', 'SalaryMonthApproved'],
                    },
                    {
                        key: 'hrm.salary.process_reminder',
                        label: 'Salary process reminder',
                        hint: 'Scheduled salary process reminder.',
                        detail: 'Daily reminder when salary process is due.',
                        dashboardTypes: [],
                        emailTypes: ['SalaryProcessReminder'],
                    },
                ],
            },
            {
                module: 'Fine',
                items: [
                    {
                        key: 'hrm.fine.request',
                        label: 'Fine request',
                        hint: 'Fine or group fine pending.',
                        detail: 'Inbox and email for fine approval and accounts action.',
                        dashboardTypes: ['Fine', 'Group Fine Request', 'Employee Fine Request'],
                        emailTypes: ['Fine', 'FineConfirmed', 'FineAccounts'],
                    },
                ],
            },
            {
                module: 'Loan and Advance',
                items: [
                    {
                        key: 'hrm.loan.request',
                        label: 'Loan and advance request',
                        hint: 'Loan or advance pending.',
                        detail: 'Inbox and email for loan / advance requests.',
                        dashboardTypes: [
                            'Loan',
                            'Loan Request',
                            'Advance',
                            'Loan and Advance',
                            'Loan/Advance',
                            'Employee Advance Request',
                            'Employee Loan Request',
                        ],
                        emailTypes: ['Loan'],
                    },
                ],
            },
            {
                module: 'Reward',
                items: [
                    {
                        key: 'hrm.reward.request',
                        label: 'Reward request',
                        hint: 'Reward pending approval.',
                        detail: 'Inbox and email for reward workflow.',
                        dashboardTypes: ['Reward'],
                        emailTypes: ['Reward'],
                    },
                ],
            },
            {
                module: 'Vehicle Asset',
                items: [
                    {
                        key: 'hrm.vehicle.document_expiry',
                        label: 'Vehicle document expiry',
                        hint: 'Mulkiya, insurance, and other vehicle docs.',
                        detail: 'Inbox reminder when a vehicle document is near expiry.',
                        dashboardTypes: ['Vehicle Document Expiry Reminder'],
                        emailTypes: ['VehicleDocumentExpiry'],
                    },
                    {
                        key: 'hrm.vehicle.service',
                        label: 'Vehicle service request',
                        hint: 'Service, inspection, and related fleet tasks.',
                        detail: 'Inbox and email for vehicle service, inspection, and profile tasks.',
                        dashboardTypes: [
                            'Vehicle Service Request',
                            'Vehicle Profile Activation',
                            'Vehicle Profile Edit',
                            'Vehicle Profile Incomplete',
                            'Vehicle Inspection',
                            'Vehicle Assignment Photo Review',
                            'Vehicle Mortgage Close',
                            'Vehicle Disposition Request',
                            'Vehicle Access Fuel Reminder',
                        ],
                        emailTypes: ['VehicleService', 'VehicleFuel'],
                    },
                ],
            },
            {
                module: 'Tools Asset',
                items: [
                    {
                        key: 'hrm.tools.assignment',
                        label: 'Tools asset assignment and approval',
                        hint: 'Assign, approve, return, transfer tools.',
                        detail: 'Inbox and email for tools asset workflow.',
                        dashboardTypes: [
                            'Asset Approval',
                            'Asset Assignment',
                            'Asset Return',
                            'Asset Transfer',
                            'Asset',
                        ],
                        emailTypes: ['AssetAssignment'],
                    },
                ],
            },
            {
                module: 'Utility Bills',
                items: [
                    {
                        key: 'hrm.utility.bill_payment',
                        label: 'Utility bill payment',
                        hint: 'Bill review, pay, and payment-day reminder.',
                        detail: 'Inbox and email for utility bill payment and reminders.',
                        dashboardTypes: [
                            'Utility Bill Payment',
                            'Utility Bill Payment Reminder',
                            'Utility Entry Status Change',
                        ],
                        emailTypes: ['UtilityBillPayment'],
                    },
                    {
                        key: 'hrm.utility.contract_expiry',
                        label: 'Utility contract expiry',
                        hint: 'SIM / utility contract near expiry.',
                        detail: 'Inbox and email when a utility contract is near expiry.',
                        dashboardTypes: ['Utility Contract Expiry'],
                        emailTypes: ['UtilityContractExpiry'],
                    },
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
                    {
                        key: 'accounts.payments.approval',
                        label: 'Payment approval',
                        hint: 'Payment waiting Accounts / approver.',
                        detail: 'Inbox and email for payment approval.',
                        dashboardTypes: ['Payment Approval'],
                        emailTypes: ['PaymentApproval'],
                    },
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
