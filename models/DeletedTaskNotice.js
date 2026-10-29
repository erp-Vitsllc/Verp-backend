import mongoose from "mongoose";

const deletedTaskNoticeSchema = new mongoose.Schema(
    {
        noticeKey: { type: String, required: true, unique: true },
        requestType: { type: String, default: "" },
        extra1: { type: String, default: "" },
    },
    { timestamps: true },
);

export default mongoose.model("DeletedTaskNotice", deletedTaskNoticeSchema);
