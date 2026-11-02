import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEligibleReportee } from "./reporteeEligibility.js";

const eligible = {
    profileStatus: "active",
    status: "Permanent",
    loginThrough: { portalApp: false, web: true },
    companyEmail: "manager@company.com",
};

describe("reportee dropdown eligibility", () => {
    it("includes an active employee with web access and a company email", () => {
        assert.equal(isEligibleReportee(eligible), true);
    });

    it("includes web access even when the portal app is also enabled", () => {
        assert.equal(
            isEligibleReportee({
                ...eligible,
                loginThrough: { portalApp: true, web: true },
            }),
            true,
        );
    });

    it("excludes portal app access without web", () => {
        assert.equal(
            isEligibleReportee({
                ...eligible,
                loginThrough: { portalApp: true, web: false },
            }),
            false,
        );
    });

    it("excludes an inactive profile", () => {
        assert.equal(isEligibleReportee({ ...eligible, profileStatus: "inactive" }), false);
    });

    it("treats a profile that was activated as active", () => {
        assert.equal(
            isEligibleReportee({
                ...eligible,
                profileStatus: "inactive",
                profileApprovalStatus: "active",
            }),
            true,
        );
    });

    it("excludes a left user", () => {
        assert.equal(isEligibleReportee({ ...eligible, status: "Left User" }), false);
    });

    it("requires a company email, not a personal email", () => {
        assert.equal(isEligibleReportee({ ...eligible, companyEmail: "  " }), false);
        assert.equal(
            isEligibleReportee({ ...eligible, companyEmail: "", email: "personal@example.com" }),
            false,
        );
    });
});
