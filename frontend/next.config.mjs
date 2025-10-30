import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default config;
