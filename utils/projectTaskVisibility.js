/** The flowchart Project Manager and Project Coordinator see every project task. */
export function viewerIsFlowchartProjectLead(viewer, rows) {
    const id = String(viewer?.employeeObjectId || "").trim();
    const code = String(viewer?.employeeId || "").trim().toLowerCase();
    return (rows || []).some((row) => {
        const rowId = String(row?.empObjectId || "").trim();
        const rowCode = String(row?.employeeId || "").trim().toLowerCase();
        return Boolean((id && rowId && id === rowId) || (code && rowCode && code === rowCode));
    });
}
