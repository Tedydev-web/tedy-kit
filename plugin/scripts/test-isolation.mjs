import { join } from "node:path";
import { tempDir } from "./temp-dir-for-tests.mjs";

const scratch = tempDir("tedy-test-env-");

Object.assign(process.env, {
  HOME: join(scratch, "home"),
  TEDY_PROFILE_DIR: join(scratch, "profile"),
  TEDY_STATE_DIR: join(scratch, "state"),
  TEDY_CLAUDE_SETTINGS: join(scratch, "settings.json"),
  TEDY_RELEASE_DIR: join(scratch, "release"),
  TEDY_CLAUDE_MD: join(scratch, "CLAUDE.md"),
  TEDY_KNOWN_MARKETPLACES: join(scratch, "known_marketplaces.json"),
});
