-- Up Migration
-- Reference configuration (NOT demo data; safe for every environment). Requirements §5: initially only
-- Salon is active; every other vertical exists as a disabled category and is switched on from the admin
-- portal. No prices, providers or bookings live here.
INSERT INTO catalog.categories (id, code, name, description, is_active, booking_flow_type, sort_order) VALUES
  ('00000000-0000-7000-8000-000000000101', 'salon',          'Salon',          'Hair, beauty and grooming services',        true,  'APPOINTMENT_SLOT',           10),
  ('00000000-0000-7000-8000-000000000102', 'spa',            'Spa',            'Massage and wellness',                      false, 'APPOINTMENT_SLOT',           20),
  ('00000000-0000-7000-8000-000000000103', 'doctor',         'Doctor',         'Doctor consultations',                      false, 'APPOINTMENT_SLOT',           30),
  ('00000000-0000-7000-8000-000000000104', 'clinic',         'Clinic',         'Clinic visits',                             false, 'APPOINTMENT_SLOT',           40),
  ('00000000-0000-7000-8000-000000000105', 'pathology_lab',  'Pathology lab',  'Diagnostic tests with sample collection',   false, 'TEST_ORDER_WITH_COLLECTION', 50),
  ('00000000-0000-7000-8000-000000000106', 'vehicle_service','Vehicle service','Vehicle servicing and repair',              false, 'APPOINTMENT_SLOT',           60),
  ('00000000-0000-7000-8000-000000000107', 'home_services',  'Home services',  'Professionals who come to your location',   false, 'SERVICE_REQUEST_WINDOW',     70),
  ('00000000-0000-7000-8000-000000000108', 'restaurant',     'Restaurant',     'Table reservations',                        false, 'TABLE_RESERVATION',          80);

INSERT INTO catalog.service_types (id, category_id, code, name, sort_order) VALUES
  ('00000000-0000-7000-8000-000000000201', '00000000-0000-7000-8000-000000000101', 'haircut',       'Haircut',       10),
  ('00000000-0000-7000-8000-000000000202', '00000000-0000-7000-8000-000000000101', 'shaving',       'Shaving',       20),
  ('00000000-0000-7000-8000-000000000203', '00000000-0000-7000-8000-000000000101', 'hair_coloring', 'Hair coloring', 30),
  ('00000000-0000-7000-8000-000000000204', '00000000-0000-7000-8000-000000000101', 'facial',        'Facial',        40);

-- Down Migration
