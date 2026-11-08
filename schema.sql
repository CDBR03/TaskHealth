-- Clara Saúde: estrutura demonstrativa do banco relacional SQLite.
-- Não armazene dados reais de saúde neste protótipo.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('patient', 'staff')),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  privacy_notice_version TEXT,
  privacy_accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS specialties (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS availability_slots (
  id INTEGER PRIMARY KEY,
  specialty_id INTEGER NOT NULL REFERENCES specialties(id),
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 10 AND 240),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (specialty_id, starts_at)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  slot_id INTEGER NOT NULL REFERENCES availability_slots(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Um horário só pode ter um pedido ativo; cancelamentos liberam o horário novamente.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_appointment_per_slot
  ON appointments(slot_id) WHERE status IN ('pending', 'confirmed');

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS appointments_by_patient ON appointments(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS appointments_by_slot_status ON appointments(slot_id, status);
CREATE INDEX IF NOT EXISTS slots_by_specialty_and_time ON availability_slots(specialty_id, starts_at);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

INSERT OR IGNORE INTO specialties (name) VALUES
  ('Clínica geral'),
  ('Cardiologia'),
  ('Pediatria');
