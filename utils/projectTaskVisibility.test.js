import assert from "node:assert/strict";
import test from "node:test";
import { viewerIsFlowchartProjectLead } from "./projectTaskVisibility.js";

const rows = [
    { category: "projectmanager", empObjectId: "mgr1", employeeId: "VEGA-PM-001" },
    { category: "projectcoordinator", empObjectId: "pc1", employeeId: "VEGA-PC-001" },
];

test("the project manager and project coordinator see every project task", () => {
    assert.equal(viewerIsFlowchartProjectLead({ employeeObjectId: "mgr1" }, rows), true);
    assert.equal(viewerIsFlowchartProjectLead({ employeeId: "VEGA-PC-001" }, rows), true);
    assert.equal(viewerIsFlowchartProjectLead({ employeeObjectId: "other", employeeId: "VEGA-HR-002" }, rows), false);
    assert.equal(viewerIsFlowchartProjectLead(null, rows), false);
});
