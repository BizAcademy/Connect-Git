import { fileURLToPath } from "node:url";
import { startSabitoSupervisor } from "../lib/sabito-supervisor";

startSabitoSupervisor(fileURLToPath(new URL("./sabito-worker.mjs", import.meta.url)));
