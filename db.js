import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'funnel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT, page TEXT, url TEXT, referrer TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    fbc TEXT, fbp TEXT, ip TEXT, user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT, email TEXT, phone TEXT,
    ghl_contact_id TEXT, ghl_status TEXT, capi_status TEXT, capi_received INTEGER, gm_status TEXT,
    event_id TEXT, fbc TEXT, fbp TEXT, ip TEXT, user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
