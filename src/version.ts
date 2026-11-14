import { version } from "../package.json";

/** The app version, from package.json (kept in sync with tauri.conf.json and Cargo.toml). */
export const APP_VERSION: string = version;
