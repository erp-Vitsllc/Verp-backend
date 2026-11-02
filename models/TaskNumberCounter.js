import mongoose from "mongoose";

const taskNumberCounterSchema = new mongoose.Schema({
    _id: { type: String },
    seq: { type: Number, default: 0 },
});

export default mongoose.model("TaskNumberCounter", taskNumberCounterSchema);
