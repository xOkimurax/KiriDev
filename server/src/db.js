import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'hub.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  session_id TEXT,
  session_started INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid, id);
CREATE TABLE IF NOT EXISTS persona_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function seedAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    console.warn('[seed] ADMIN_PASSWORD no definido: no se creó usuario inicial');
    return;
  }
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(user, bcrypt.hashSync(pass, 10), 'admin');
  console.log(`[seed] usuario inicial "${user}" creado`);
}

// ids de mensajes ya procesados (Evolution a veces reenvía el mismo evento)
db.exec('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
db.exec("DELETE FROM seen WHERE at < datetime('now','-2 days')");

// archivos que el agente envía: Evolution los descarga por una URL con id aleatorio y vencimiento
db.exec('CREATE TABLE IF NOT EXISTS outfiles (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, expires INTEGER NOT NULL)');
db.prepare('DELETE FROM outfiles WHERE expires < ?').run(Date.now());

// tareas delegadas a sub agentes (trabajan en segundo plano; al terminar el agente principal le avisa a la persona)
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  result TEXT,
  error TEXT,
  files TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_jid ON tasks(jid, id)');

// sesiones de Claude (transcripciones en disco) que pertenecen a cada contacto: permiten borrar TODO su contexto
db.exec('CREATE TABLE IF NOT EXISTS session_log (session_id TEXT PRIMARY KEY, jid TEXT NOT NULL, kind TEXT NOT NULL DEFAULT \'chat\', created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_log_jid ON session_log(jid)');
db.exec("INSERT OR IGNORE INTO session_log (session_id, jid, kind) SELECT session_id, jid, 'chat' FROM contacts WHERE session_id IS NOT NULL");

// mensaje citado ("responder" de WhatsApp): texto citado y, si se encuentra en el historial, el id del mensaje original
for (const col of ['quoted TEXT', 'quoted_id INTEGER']) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch { /* ya existe */ }
}

// quién escribió cada mensaje (en grupos) y si el nombre del contacto es el asunto real del grupo
for (const t of ['ALTER TABLE messages ADD COLUMN sender TEXT', 'ALTER TABLE contacts ADD COLUMN group_named INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(t); } catch { /* ya existe */ }
}

try { db.exec('ALTER TABLE messages ADD COLUMN media TEXT'); } catch { /* ya existe */ }

// ids de WhatsApp: del mensaje de la persona (para citarlo/editarlo) y de cada mensaje que el agente envió como respuesta
for (const t of ['ALTER TABLE messages ADD COLUMN wa_id TEXT', 'ALTER TABLE messages ADD COLUMN wa_participant TEXT']) {
  try { db.exec(t); } catch { /* ya existe */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS sent_msgs (
  wa_id TEXT PRIMARY KEY, jid TEXT NOT NULL, msg_id INTEGER NOT NULL, idx INTEGER NOT NULL DEFAULT 0, reply_to TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_waid ON messages (jid, wa_id)');

for (const t of ['ALTER TABLE messages ADD COLUMN wa_secret TEXT', 'ALTER TABLE messages ADD COLUMN edited_from TEXT']) { try { db.exec(t); } catch { /* ya existe */ } }

