-- Up Migration
-- Reference configuration (NOT demo data; safe for every environment): the kinds of service a business can pick when it adds a
-- service, for every vertical that was created but had none (and a few more for Salon). Categories stay exactly as they are: a vertical
-- is only offered to businesses once an administrator switches it on in the admin portal, and any type below can be renamed,
-- re-ordered or switched off there. No prices, providers or bookings live here.
--
-- Category ids: 101 salon, 102 spa, 103 doctor, 104 clinic, 105 pathology_lab, 106 vehicle_service, 107 home_services, 108 restaurant.
INSERT INTO catalog.service_types (id, category_id, code, name, sort_order) VALUES
  -- Salon (haircut, shaving, hair_coloring and facial already exist: 10-40)
  ('00000000-0000-7000-8000-000000000205', '00000000-0000-7000-8000-000000000101', 'head_massage',  'Head massage',  50),
  ('00000000-0000-7000-8000-000000000206', '00000000-0000-7000-8000-000000000101', 'hair_spa',      'Hair spa',      60),
  ('00000000-0000-7000-8000-000000000207', '00000000-0000-7000-8000-000000000101', 'beard_trim',    'Beard trim',    70),
  ('00000000-0000-7000-8000-000000000208', '00000000-0000-7000-8000-000000000101', 'manicure',      'Manicure',      80),
  ('00000000-0000-7000-8000-000000000209', '00000000-0000-7000-8000-000000000101', 'pedicure',      'Pedicure',      90),
  ('00000000-0000-7000-8000-00000000020a', '00000000-0000-7000-8000-000000000101', 'waxing',        'Waxing',        100),
  -- Spa
  ('00000000-0000-7000-8000-00000000020b', '00000000-0000-7000-8000-000000000102', 'massage',          'Massage',          10),
  ('00000000-0000-7000-8000-00000000020c', '00000000-0000-7000-8000-000000000102', 'body_scrub',       'Body scrub',       20),
  ('00000000-0000-7000-8000-00000000020d', '00000000-0000-7000-8000-000000000102', 'aromatherapy',     'Aromatherapy',     30),
  ('00000000-0000-7000-8000-00000000020e', '00000000-0000-7000-8000-000000000102', 'steam_sauna',      'Steam and sauna',  40),
  ('00000000-0000-7000-8000-00000000020f', '00000000-0000-7000-8000-000000000102', 'foot_reflexology', 'Foot reflexology', 50),
  -- Doctor
  ('00000000-0000-7000-8000-000000000210', '00000000-0000-7000-8000-000000000103', 'general_consultation',    'General consultation',    10),
  ('00000000-0000-7000-8000-000000000211', '00000000-0000-7000-8000-000000000103', 'specialist_consultation', 'Specialist consultation', 20),
  ('00000000-0000-7000-8000-000000000212', '00000000-0000-7000-8000-000000000103', 'follow_up',               'Follow-up visit',         30),
  -- Clinic
  ('00000000-0000-7000-8000-000000000213', '00000000-0000-7000-8000-000000000104', 'health_checkup', 'Health check-up',                10),
  ('00000000-0000-7000-8000-000000000214', '00000000-0000-7000-8000-000000000104', 'dental',         'Dental care',                   20),
  ('00000000-0000-7000-8000-000000000215', '00000000-0000-7000-8000-000000000104', 'vaccination',    'Vaccination',                   30),
  ('00000000-0000-7000-8000-000000000216', '00000000-0000-7000-8000-000000000104', 'physiotherapy',  'Physiotherapy',                 40),
  ('00000000-0000-7000-8000-000000000217', '00000000-0000-7000-8000-000000000104', 'dressing',       'Dressing and minor procedures', 50),
  -- Pathology lab
  ('00000000-0000-7000-8000-000000000218', '00000000-0000-7000-8000-000000000105', 'blood_test',        'Blood test',                  10),
  ('00000000-0000-7000-8000-000000000219', '00000000-0000-7000-8000-000000000105', 'urine_test',        'Urine test',                  20),
  ('00000000-0000-7000-8000-00000000021a', '00000000-0000-7000-8000-000000000105', 'full_body_checkup', 'Full body check-up',         30),
  ('00000000-0000-7000-8000-00000000021b', '00000000-0000-7000-8000-000000000105', 'imaging',           'Imaging (X-ray, ultrasound)', 40),
  -- Vehicle service
  ('00000000-0000-7000-8000-00000000021c', '00000000-0000-7000-8000-000000000106', 'car_wash',        'Car wash',                      10),
  ('00000000-0000-7000-8000-00000000021d', '00000000-0000-7000-8000-000000000106', 'painting_denting','Painting and denting',         20),
  ('00000000-0000-7000-8000-00000000021e', '00000000-0000-7000-8000-000000000106', 'air_check',       'Air check',                     30),
  ('00000000-0000-7000-8000-00000000021f', '00000000-0000-7000-8000-000000000106', 'tyre_change',     'Tyre change',                   40),
  ('00000000-0000-7000-8000-000000000220', '00000000-0000-7000-8000-000000000106', 'general_service', 'General service',              50),
  ('00000000-0000-7000-8000-000000000221', '00000000-0000-7000-8000-000000000106', 'oil_change',      'Oil change',                    60),
  ('00000000-0000-7000-8000-000000000222', '00000000-0000-7000-8000-000000000106', 'wheel_alignment', 'Wheel alignment',              70),
  ('00000000-0000-7000-8000-000000000223', '00000000-0000-7000-8000-000000000106', 'battery_service', 'Battery check and replacement', 80),
  ('00000000-0000-7000-8000-000000000224', '00000000-0000-7000-8000-000000000106', 'ac_service',      'AC service',                    90),
  -- Home services
  ('00000000-0000-7000-8000-000000000225', '00000000-0000-7000-8000-000000000107', 'cleaning',         'Home cleaning',    10),
  ('00000000-0000-7000-8000-000000000226', '00000000-0000-7000-8000-000000000107', 'plumbing',         'Plumbing',         20),
  ('00000000-0000-7000-8000-000000000227', '00000000-0000-7000-8000-000000000107', 'electrician',      'Electrician',      30),
  ('00000000-0000-7000-8000-000000000228', '00000000-0000-7000-8000-000000000107', 'ac_repair',        'AC repair',        40),
  ('00000000-0000-7000-8000-000000000229', '00000000-0000-7000-8000-000000000107', 'appliance_repair', 'Appliance repair', 50),
  ('00000000-0000-7000-8000-00000000022a', '00000000-0000-7000-8000-000000000107', 'pest_control',     'Pest control',     60),
  ('00000000-0000-7000-8000-00000000022b', '00000000-0000-7000-8000-000000000107', 'carpentry',        'Carpentry',        70),
  ('00000000-0000-7000-8000-00000000022c', '00000000-0000-7000-8000-000000000107', 'painting',         'Painting',         80),
  -- Restaurant
  ('00000000-0000-7000-8000-00000000022d', '00000000-0000-7000-8000-000000000108', 'table_booking', 'Table booking', 10)
ON CONFLICT (category_id, code) DO NOTHING;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
