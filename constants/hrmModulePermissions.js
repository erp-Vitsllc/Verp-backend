/**
 * HRM permission tree — used by services/permissionService.js (MODULES_STRUCTURE).
 * Keep in sync with VERP_frontend/src/constants/hrmModulePermissions.js (Settings → Groups UI).
 */

const ownerCompanyDocs = [
    { id: 'hrm_company_view_owner_passport', label: 'Passport', parent: 'hrm_company_view_owner', hasDownload: true },
    { id: 'hrm_company_view_owner_visa', label: 'Visa', parent: 'hrm_company_view_owner', hasDownload: true },
    { id: 'hrm_company_view_owner_labour_card', label: 'Labour Card', parent: 'hrm_company_view_owner', hasDownload: true },
    { id: 'hrm_company_view_owner_emirates_id', label: 'Emirates ID', parent: 'hrm_company_view_owner', hasDownload: true },
    { id: 'hrm_company_view_owner_medical_insurance', label: 'Medical Insurance', parent: 'hrm_company_view_owner', hasDownload: true },
    { id: 'hrm_company_view_owner_driving_license', label: 'Driving License', parent: 'hrm_company_view_owner', hasDownload: true },
];

const companyDocumentsChildren = [
    { id: 'hrm_company_view_documents_live', label: 'Live Documents', parent: 'hrm_company_view_documents', hasDownload: true },
    { id: 'hrm_company_view_documents_old', label: 'Old Documents', parent: 'hrm_company_view_documents', hasDownload: true },
    { id: 'hrm_company_view_documents_memo', label: 'Memo', parent: 'hrm_company_view_documents', hasDownload: true },
    { id: 'hrm_company_view_documents_certificate', label: 'Certificate', parent: 'hrm_company_view_documents', hasDownload: true },
];

const employeeBasicChildren = [
    { id: 'hrm_employees_view_basic', label: 'Basic (identity & company)', parent: 'hrm_employees_view_basic_details', hasDownload: false },
    { id: 'hrm_employees_view_passport', label: 'Passport', parent: 'hrm_employees_view_basic_details', hasDownload: true },
    { id: 'hrm_employees_view_visa', label: 'Visa', parent: 'hrm_employees_view_basic_details', hasDownload: true },
    { id: 'hrm_employees_view_emirates_id', label: 'Emirates ID', parent: 'hrm_employees_view_basic_details', hasDownload: true },
    { id: 'hrm_employees_view_labour_card', label: 'Labour Card', parent: 'hrm_employees_view_basic_details', hasDownload: true },
    { id: 'hrm_employees_view_driving_license', label: 'Driving License', parent: 'hrm_employees_view_basic_details', hasDownload: true },
    { id: 'hrm_employees_view_medical_insurance', label: 'Medical Insurance', parent: 'hrm_employees_view_basic_details', hasDownload: true },
];

const employeeSalaryChildren = [
    { id: 'hrm_employees_view_salary', label: 'Salary', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_bank', label: 'Bank Details', parent: 'hrm_employees_view_salary_section', hasDownload: false },
    { id: 'hrm_employees_view_salary_history', label: 'Salary History', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_fine', label: 'Fine', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_reward', label: 'Reward', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_ncr', label: 'NCR', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_loans', label: 'Loans', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_advance', label: 'Advance', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_assets', label: 'Assets', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_ctc', label: 'CTC', parent: 'hrm_employees_view_salary_section', hasDownload: true },
    { id: 'hrm_employees_view_salary_certificate', label: 'Certificate', parent: 'hrm_employees_view_salary_section', hasDownload: true },
];

const employeePersonalChildren = [
    { id: 'hrm_employees_view_personal', label: 'Personal Details', parent: 'hrm_employees_view_personal_details', hasDownload: false },
    { id: 'hrm_employees_view_permanent_address', label: 'Permanent Address', parent: 'hrm_employees_view_personal_details', hasDownload: false },
    { id: 'hrm_employees_view_current_address', label: 'Current Address', parent: 'hrm_employees_view_personal_details', hasDownload: false },
    { id: 'hrm_employees_view_emergency', label: 'Emergency Contacts', parent: 'hrm_employees_view_personal_details', hasDownload: false },
    { id: 'hrm_employees_view_education', label: 'Education', parent: 'hrm_employees_view_personal_details', hasDownload: true },
    { id: 'hrm_employees_view_experience', label: 'Experience', parent: 'hrm_employees_view_personal_details', hasDownload: true },
];

const employeeDocumentsChildren = [
    { id: 'hrm_employees_view_documents_live', label: 'Live Documents', parent: 'hrm_employees_view_documents', hasDownload: true },
    { id: 'hrm_employees_view_documents_old', label: 'Old Documents', parent: 'hrm_employees_view_documents', hasDownload: true },
    { id: 'hrm_employees_view_documents_memo', label: 'Memo', parent: 'hrm_employees_view_documents', hasDownload: true },
    { id: 'hrm_employees_view_documents_certificate', label: 'Certificate', parent: 'hrm_employees_view_documents', hasDownload: true },
];

/** Full HRM node for group permission UI (merged into MODULES array). */
export const HRM_MODULE = {
    id: 'hrm',
    label: 'HRM',
    parent: null,
    hasDownload: false,
    children: [
        {
            id: 'hrm_company',
            label: 'Company',
            parent: 'hrm',
            hasDownload: false,
            children: [
                { id: 'hrm_company_list', label: 'Company List', parent: 'hrm_company', hasDownload: true },
                { id: 'hrm_company_add', label: 'Add Company', parent: 'hrm_company', hasDownload: false },
                {
                    id: 'hrm_company_view',
                    label: 'View Company',
                    parent: 'hrm_company',
                    hasDownload: false,
                    children: [
                        {
                            id: 'hrm_company_view_basic',
                            label: 'Basic Details',
                            parent: 'hrm_company_view',
                            hasDownload: false,
                            children: [
                                {
                                    id: 'hrm_company_view_basic_trade_license',
                                    label: 'Trade License',
                                    parent: 'hrm_company_view_basic',
                                    hasDownload: true,
                                },
                                {
                                    id: 'hrm_company_view_basic_establishment_card',
                                    label: 'Establishment Card',
                                    parent: 'hrm_company_view_basic',
                                    hasDownload: true,
                                },
                                { id: 'hrm_company_view_basic_ejari', label: 'Ejari', parent: 'hrm_company_view_basic', hasDownload: true },
                            ],
                        },
                        {
                            id: 'hrm_company_view_owner',
                            label: 'Owner Information',
                            parent: 'hrm_company_view',
                            hasDownload: false,
                            children: ownerCompanyDocs,
                        },
                        { id: 'hrm_company_view_assets', label: 'Assets', parent: 'hrm_company_view', hasDownload: true },
                        { id: 'hrm_company_view_fine', label: 'Fine', parent: 'hrm_company_view', hasDownload: true },
                        {
                            id: 'hrm_company_view_documents',
                            label: 'Documents',
                            parent: 'hrm_company_view',
                            hasDownload: false,
                            children: companyDocumentsChildren,
                        },
                    ],
                },
            ],
        },
        {
            id: 'hrm_employees',
            label: 'Employees',
            parent: 'hrm',
            hasDownload: false,
            children: [
                { id: 'hrm_employees_add', label: 'Add Employee', parent: 'hrm_employees', hasDownload: false },
                { id: 'hrm_employees_list', label: 'Employee List', parent: 'hrm_employees', hasDownload: false },
                {
                    id: 'hrm_employees_view',
                    label: 'View Employee',
                    parent: 'hrm_employees',
                    hasDownload: false,
                    children: [
                        {
                            id: 'hrm_employees_view_basic_details',
                            label: 'Basic Details',
                            parent: 'hrm_employees_view',
                            hasDownload: false,
                            children: employeeBasicChildren,
                        },
                        {
                            id: 'hrm_employees_view_work_details',
                            label: 'Work Details',
                            parent: 'hrm_employees_view',
                            hasDownload: false,
                            children: [
                                {
                                    id: 'hrm_employees_view_work',
                                    label: 'Digital Signature / Work',
                                    parent: 'hrm_employees_view_work_details',
                                    hasDownload: false,
                                },
                            ],
                        },
                        {
                            id: 'hrm_employees_view_salary_section',
                            label: 'Salary',
                            parent: 'hrm_employees_view',
                            hasDownload: false,
                            children: employeeSalaryChildren,
                        },
                        {
                            id: 'hrm_employees_view_personal_details',
                            label: 'Personal Details',
                            parent: 'hrm_employees_view',
                            hasDownload: false,
                            children: employeePersonalChildren,
                        },
                        {
                            id: 'hrm_employees_view_documents',
                            label: 'Documents',
                            parent: 'hrm_employees_view',
                            hasDownload: false,
                            children: employeeDocumentsChildren,
                        },
                        { id: 'hrm_employees_view_training', label: 'Training', parent: 'hrm_employees_view', hasDownload: true },
                    ],
                },
            ],
        },
        { id: 'hrm_attendance', label: 'Attendance', parent: 'hrm', hasDownload: true },
        { id: 'hrm_leave', label: 'Leave', parent: 'hrm', hasDownload: true },
        { id: 'hrm_ncr', label: 'NCR', parent: 'hrm', hasDownload: true },
        { id: 'hrm_fine', label: 'Fine', parent: 'hrm', hasDownload: true },
        { id: 'hrm_loan', label: 'Loan / Advance', parent: 'hrm', hasDownload: true },
        { id: 'hrm_reward', label: 'Reward', parent: 'hrm', hasDownload: true },
        { id: 'hrm_asset', label: 'Asset', parent: 'hrm', hasDownload: true },
    ],
};

/** Company profile main tabs: show tab if View on any listed module (or admin). */
export const COMPANY_MAIN_TAB_MODULES = {
    basic: [
        'hrm_company_view_basic',
        'hrm_company_view_basic_trade_license',
        'hrm_company_view_basic_establishment_card',
        'hrm_company_view_basic_ejari',
    ],
    owner: [
        'hrm_company_view_owner',
        'hrm_company_view_owner_passport',
        'hrm_company_view_owner_visa',
        'hrm_company_view_owner_labour_card',
        'hrm_company_view_owner_emirates_id',
        'hrm_company_view_owner_medical_insurance',
        'hrm_company_view_owner_driving_license',
    ],
    assets: ['hrm_company_view_assets'],
    fine: ['hrm_company_view_fine'],
    documents: [
        'hrm_company_view_documents',
        'hrm_company_view_documents_live',
        'hrm_company_view_documents_old',
        'hrm_company_view_documents_memo',
        'hrm_company_view_documents_certificate',
    ],
    /** Company profile reuses the employee shell; "Work Details" maps to owner cards. */
    'work-details': [
        'hrm_company_view_owner',
        'hrm_company_view_owner_passport',
        'hrm_company_view_owner_visa',
        'hrm_company_view_owner_labour_card',
        'hrm_company_view_owner_emirates_id',
        'hrm_company_view_owner_medical_insurance',
        'hrm_company_view_owner_driving_license',
    ],
};

/** Employee profile main tabs. */
export const EMPLOYEE_MAIN_TAB_MODULES = {
    basic: [
        'hrm_employees_view_basic_details',
        'hrm_employees_view_basic',
        'hrm_employees_view_passport',
        'hrm_employees_view_visa',
        'hrm_employees_view_emirates_id',
        'hrm_employees_view_labour_card',
        'hrm_employees_view_medical_insurance',
        'hrm_employees_view_driving_license',
    ],
    'work-details': ['hrm_employees_view_work_details', 'hrm_employees_view_work'],
    salary: [
        'hrm_employees_view_salary_section',
        'hrm_employees_view_salary',
        'hrm_employees_view_bank',
        'hrm_employees_view_salary_history',
        'hrm_employees_view_salary_fine',
        'hrm_employees_view_salary_reward',
        'hrm_employees_view_salary_ncr',
        'hrm_employees_view_salary_loans',
        'hrm_employees_view_salary_advance',
        'hrm_employees_view_salary_assets',
        'hrm_employees_view_salary_ctc',
        'hrm_employees_view_salary_certificate',
    ],
    personal: [
        'hrm_employees_view_personal_details',
        'hrm_employees_view_personal',
        'hrm_employees_view_permanent_address',
        'hrm_employees_view_current_address',
        'hrm_employees_view_emergency',
        'hrm_employees_view_education',
        'hrm_employees_view_experience',
    ],
    documents: [
        'hrm_employees_view_documents',
        'hrm_employees_view_documents_live',
        'hrm_employees_view_documents_old',
        'hrm_employees_view_documents_memo',
        'hrm_employees_view_documents_certificate',
    ],
    training: ['hrm_employees_view_training'],
};
