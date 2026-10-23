// Where the simulator takes the REAL client modules from: src/lib of this checkout, or the directory in SIM_LIB (e.g. a
// snapshot of a commit: `git show <rev>:src/lib/<file>` for every file, so a run can target the shipped build while the
// working copy is being edited).
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const LIB_DIR = process.env.SIM_LIB ? resolve(process.env.SIM_LIB) : join(here, "..", "..", "src", "lib");
export const libUrl = (file) => pathToFileURL(join(LIB_DIR, file)).href;
