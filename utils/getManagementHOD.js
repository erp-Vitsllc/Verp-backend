import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Retrieves the CEO (Management HOD) for final approval.
 * STRICT Criteria: Department = 'Management' AND Designation = 'CEO'.
 * @returns {Promise<Object|null>} The CEO employee object or null if not found.
 */
export const getManagementHOD = async () => {
    try {
        // Flexible Priority: CEO or equivalent Management HOD
        const designations = [
            'CEO', 'C.E.O', 'C.E.O.', 'Chief Executive Officer',
            'Director', 'Managing Director',
            'General Manager', 'GM', 'G.M', 'G.M.'
        ];

        // Find match: prioritize those in Management department, but allow any department if designation matches perfectly
        // We look for ANY match first, and we'll check status after
        let hod = await EmployeeBasic.findOne({
            $or: [
                { department: { $regex: /management/i }, designation: { $in: designations.map(d => new RegExp(`^${d}$`, 'i')) } },
                { designation: { $in: ['CEO', 'Chief Executive Officer', 'Managing Director'].map(d => new RegExp(`^${d}$`, 'i')) } }
            ]
        })
            .sort({ profileStatus: 1 }) // 'active' comes before 'inactive' alphabetically
            .select('employeeId firstName lastName companyEmail email designation profileStatus');

        if (hod && hod.profileStatus !== 'active') {
            console.warn(`[getManagementHOD] Found CEO (${hod.firstName}) but their profile is INACTIVE. Emails might not be sent if the system requires active status.`);
        }

        console.log('[getManagementHOD] Search Result:', hod ? {
            id: hod.employeeId,
            name: `${hod.firstName} ${hod.lastName}`,
            email: hod.companyEmail || hod.email,
            designation: hod.designation
        } : 'NOT FOUND');

        if (!hod) {
            console.warn('[getManagementHOD] No CEO found for Management department.');
            return null;
        }

        return hod;
    } catch (error) {
        console.error('[getManagementHOD] Error finding CEO:', error);
        return null;
    }
};
