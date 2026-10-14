CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'resident' CHECK (role IN ('resident', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (id, email, password_hash, role)
VALUES ('user-ben-kastner', 'ben@vincetigo.com', NULL, 'admin')
ON CONFLICT(email) DO UPDATE SET role = 'admin';

CREATE TABLE IF NOT EXISTS dispatch_tickets (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('Standard', 'Urgent')),
  status TEXT NOT NULL CHECK (status IN ('Submitted', 'Under Review', 'Contractor Dispatched', 'In Progress', 'Completed')),
  date TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO dispatch_tickets
  (id, unit, title, category, priority, status, date, assignee, notes)
VALUES
  ('VIN-102', 'Unit 3B (Address undisclosed)', 'Master bath ventilation motor resonance', 'Electrical', 'Standard', 'Contractor Dispatched', 'Sept 12, 2026', 'Apex Electricians LLC', 'Tech scheduled for Tuesday window 10am-12pm.'),
  ('VIN-101', 'Unit 3B (Address undisclosed)', 'Kitchen drainage cycle slow discharge', 'Plumbing', 'Urgent', 'In Progress', 'Sept 14, 2026', 'Center City Plumbing Co.', 'Main trap cleared. Technician replacing rubber gaskets.');
