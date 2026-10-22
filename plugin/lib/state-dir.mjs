import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.TEDY_STATE_DIR ?? join(homedir(), ".local", "state", "tedy");
