import { upsertJob } from "../plugins/gemini/scripts/lib/state.mjs";

const [workspace, id] = process.argv.slice(2);
upsertJob(workspace, { id, status: "completed", worker: id });
