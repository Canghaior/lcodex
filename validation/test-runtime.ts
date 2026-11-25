import { homedir } from "node:os";
import { runtimePaths } from "../src/main/runtime.js";

// Select the same pinned runtime as development. WindowsFileGuard still checks
// its original hash; fixture assertions and independent acceptors are unchanged.
export const validationShell = runtimePaths(process.cwd(), "", false, homedir()).shell;
