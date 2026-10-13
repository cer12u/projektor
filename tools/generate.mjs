import fs from "node:fs";
import { generated } from "./catalogs.mjs";

const content = generated(process.cwd());
fs.mkdirSync("platform/generated", { recursive: true });
fs.writeFileSync("platform/generated/catalogs.ts", content);
