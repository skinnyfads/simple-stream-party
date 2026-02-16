import dotenv from "dotenv";
import { cleanEnv, num, str } from "envalid";

dotenv.config();

const env = cleanEnv(process.env, {
  HOST: str({ default: "0.0.0.0" }),
  PORT: num({ default: 3000 }),
  DATA_DIR: str({ default: "data" }),
  PUBLIC_BASE_URL: str({ default: "" }),
});

export default env;
