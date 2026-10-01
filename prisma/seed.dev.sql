-- DEVELOPMENT ONLY: two demo schools with fixed IDs so the API can be exercised
-- before the (out-of-scope) "Add school" API exists.
INSERT INTO schools (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Demo School A'),
  ('22222222-2222-4222-8222-222222222222', 'Demo School B')
ON CONFLICT (id) DO NOTHING;
