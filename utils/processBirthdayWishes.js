import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeePersonal from "../models/EmployeePersonal.js";
import BirthdayReminderLog from "../models/BirthdayReminderLog.js";
import { sendBirthdayWishEmail } from "./sendBirthdayWishEmail.js";
import { isEmployeeActiveForNotifications } from "./applyEmployeeLeftUserStatus.js";

const BIRTHDAY_TZ = (process.env.BIRTHDAY_TZ || "Asia/Dubai").trim();

const getCalendarPartsInTz = (date = new Date(), timeZone = BIRTHDAY_TZ) => {
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
    });
    const parts = formatter.formatToParts(date);
    const pick = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return {
        year: pick("year"),
        month: pick("month"),
        day: pick("day"),
    };
};

const dobMatchesToday = (dateOfBirth, todayMonth, todayDay) => {
    if (!dateOfBirth) return false;
    const d = new Date(dateOfBirth);
    if (Number.isNaN(d.getTime())) return false;
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return month === todayMonth && day === todayDay;
};

const employeeDisplayName = (emp) =>
    `${emp?.firstName || ""} ${emp?.lastName || ""}`.trim() || emp?.employeeId || "Employee";

/**
 * Daily job: send birthday wishes to active employees whose DOB matches today (Asia/Dubai by default).
 */
export const processBirthdayWishes = async () => {
    try {
        const { year, month, day } = getCalendarPartsInTz();

        const personalRows = await EmployeePersonal.find({
            dateOfBirth: { $exists: true, $ne: null },
        })
            .select("employeeId dateOfBirth")
            .lean();

        const birthdayEmployeeIds = personalRows
            .filter((row) => dobMatchesToday(row.dateOfBirth, month, day))
            .map((row) => row.employeeId)
            .filter(Boolean);

        if (!birthdayEmployeeIds.length) {
            return { processed: 0, sent: 0 };
        }

        const eligibleIds = birthdayEmployeeIds.filter((id) => id && id !== "VEGA-HR-0000");
        if (!eligibleIds.length) {
            return { processed: 0, sent: 0 };
        }

        const employees = await EmployeeBasic.find({
            employeeId: { $in: eligibleIds },
            profileStatus: "active",
            status: { $ne: "Left User" },
        })
            .select("employeeId firstName lastName email status profileStatus")
            .lean();

        const activeEmployees = employees.filter(isEmployeeActiveForNotifications);

        if (!activeEmployees.length) {
            return { processed: 0, sent: 0 };
        }

        const alreadySent = await BirthdayReminderLog.find({
            year,
            employeeId: { $in: activeEmployees.map((e) => e.employeeId) },
        })
            .select("employeeId")
            .lean();
        const sentSet = new Set(alreadySent.map((r) => r.employeeId));

        let sentCount = 0;

        for (const employee of activeEmployees) {
            if (sentSet.has(employee.employeeId)) continue;

            const name = employeeDisplayName(employee);
            const personalEmail = String(employee.email || "").trim() || null;

            if (!personalEmail) {
                console.warn(
                    `[BirthdayWish] Skipping ${employee.employeeId} — no personal email on file.`,
                );
                continue;
            }

            try {
                const { sent, recipients, cc = [] } = await sendBirthdayWishEmail({
                    employeeName: name,
                    personalEmail,
                });

                if (!sent) continue;

                await BirthdayReminderLog.create({
                    employeeId: employee.employeeId,
                    year,
                    sentTo: [...recipients, ...cc.map((addr) => `cc:${addr}`)],
                });

                sentSet.add(employee.employeeId);
                sentCount += 1;
                console.log(
                    `[BirthdayWish] Sent to ${recipients.join(", ")}` +
                        (cc?.length ? ` (cc: ${cc.join(", ")})` : "") +
                        ` for ${name} (${employee.employeeId})`,
                );
            } catch (err) {
                console.error(
                    `[BirthdayWish] Failed for ${employee.employeeId}:`,
                    err?.message || err,
                );
            }
        }

        return { processed: activeEmployees.length, sent: sentCount };
    } catch (err) {
        console.error("[BirthdayWish] Job failed:", err?.message || err);
        return { processed: 0, sent: 0, error: err?.message || String(err) };
    }
};
