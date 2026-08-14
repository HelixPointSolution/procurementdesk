-- ── Supplier List seed — extracted from "Procurement Desk (1).xlsx", tab "Supplier List" ──
-- Run AFTER schema.sql.
--
-- ⚠ Re-running REPLACES all material groups: the `delete from
--   supplier_materials` below wipes any groups the team has since built or
--   reordered in the Supplier List tab. Suppliers themselves are upserted, so
--   their names/emails/notes survive. Re-run only to reset groups to the
--   workbook's original contents.

-- 1) Suppliers (unique by name) --------------------------------------
insert into suppliers (name, email, note) values
  ('Kimstahl',               'kimstahl-penang@kimann.com', ''),
  ('Wong Tool',              'wongtoolsteel@gmail.com', ''),
  ('Asco',                   'sales@ascosteel.com', ''),
  ('PHH',                    'sales06@phh.com.my', ''),
  ('Long Jing',              'longjingsdnbhd@gmail.com', ''),
  ('AKT',                    'akthardware@gmail.com', ''),
  ('Syarikat L.Devaki',      'vletchm@gmail.com', ''),
  ('Ganesan Kanthan',        'gkh_2177@yahoo.com', ''),
  ('Litat Hardware',         'litathwsb@gmail.com', ''),
  ('Asia Automation',        'aaps.pg@gmail.com', ''),
  ('YanKong',                'sales.ykinorthern@gmail.com', ''),
  ('Twin Metal',             'sales04@twinmetal.com.my', ''),
  ('Three & Three',          'tthpgbm@kssc.com.my', ''),
  ('Lian Giap',              'wcgoh@liangiap.com.my', ''),
  ('Villgend',               'villgend@gmail.com', ''),
  ('UA Materials',           'sales03@uamaterials.com', ''),
  ('Beye',                   'sales@beye.com.my', ''),
  ('AMS Light Metal',        'sheena@amsmetal.com.sg', ''),
  ('TNG',                    'penang@tngsb.com.my', ''),
  ('C.T Stabil',             'sales@ctstabil.com', ''),
  ('JWS',                    'jws.pre@gmail.com', ''),
  ('ABV',                    'sales@abvsb.com', ''),
  ('TSA',                    'swng@tsa.com.my', ''),
  ('ACR',                    'eddieyap@acr-is.com', ''),
  ('Fon Kok',                'salesbw@fonkok.com.my', ''),
  ('Akas',                   null, 'Walk in to buy'),
  ('Heap Sing Huat',         'skkoay@hsh.com.my', ''),
  ('Dako',                   'dakosteel@gmail.com', ''),
  ('CSB Spring',             'csbspring@yahoo.com', ''),
  ('QE Tech',                'lisan_chooi@hotmail.com', ''),
  ('G 1 Metal',              'g.onemetals@gmail.com', ''),
  ('Lum Choon (Perai)',      'lumchoonprai@gmail.com', ''),
  ('AL Metal',               'allumetal22@gmail.com', ''),
  ('Butterworth Motorworks', 'sales@bmwsb.com', ''),
  ('Dura',                   'sales@duratools.com.my', ''),
  ('T&T',                    'tt.tools.solution@gmail.com', ''),
  ('Mapal',                  'HY.Chin@mapal.com', ''),
  ('Maxta',                  'sales@maxta.com.my', ''),
  ('New-tech Metal (NTM)',   'newtech863@gmail.com', ''),
  ('SY Precision',           'info@syprecision.com.my', ''),
  ('NW Asia',                'nwasiahwsb@gmail.com', ''),
  ('Mec-Mart',               'bw@mecmart.com.my', ''),
  ('Menschtech',             'sales.menschtech@gmail.com', ''),
  ('Yomax',                  'admin@yomax.com.my', ''),
  ('Winly Tooling',          'winly@winlytooling.com', ''),
  ('Wintools Engineering',   'sales@wintools.com.my', ''),
  ('Leadtec Tooling',        'sales.leadtec@gmail.com', ''),
  ('Sunny Score',            'sunnyscoresb@gmail.com', ''),
  ('NTK Industrial',         'ch.lee@ntkmy.com', ''),
  ('Fit System',             'sales02@fitsystems.com.my', '')
on conflict (name) do update set email = excluded.email, note = excluded.note;

-- 2) Material groups (category, materials, ordered supplier list) ----
delete from supplier_materials;

with groups(category, materials, supplier_names) as (values
  ('ALLOY STEEL', 'AISI 416',
    array['Kimstahl']),
  ('ALLOY STEEL', '440C, 440C 6 SIDE MILL, 709, 718 & 718 6 SIDE MILL, DF2 & DF2 6 SIDE MILL, XW41 & XW41 6 SIDE MILL, SKH51 & SKH51 6 SIDE MILL, SS400, STAVAX, SUS420J2, 1.2083ESR 6 SIDE MILL, XW10, A2, SKD12, S45C, 1045, 760, 1.1191 6 SIDE MILL, S50C, 1050 STEEL 6 SIDE MILL, 17-4, P20, 1.2311 6 SIDE MILL',
    array['Wong Tool','Asco','Kimstahl','PHH','Long Jing']),
  ('MILD STEEL', 'BLACK SHAFT, POLISH SHAFT, HOLLOW PIPE, KEY SHAFT, MILD STEEL ROD, POLISH SQUARE BAR, ANGLE BAR',
    array['AKT','Syarikat L.Devaki','Ganesan Kanthan','Litat Hardware']),
  ('MILD STEEL', 'MS, S275, MS 6 SIDE MILL, SPCC',
    array['Asco','Wong Tool','Kimstahl','PHH']),
  ('CARBON STEEL', 'CASE HARDENED SHAFT, HARD CHROME LINEAR SHAFT',
    array['Asia Automation']),
  ('ALU', 'ALU 6061, ALU 7075, ALU 5083, ALU 5052',
    array['YanKong','Twin Metal','Three & Three','Lian Giap','Villgend','PHH','UA Materials','Beye','AMS Light Metal']),
  ('ALUMINIUM', 'ALUMINIUM PROFILE',
    array['Asia Automation','UA Materials','AMS Light Metal']),
  ('PLASTIC', 'PEEK, PFA, TEFLON, PTFE, ULTEM, PEI, PU, DELRIN, ESD ACRYLIC PERSPEX, NYLON, CLEAR POLYCARBONATE, BAKELITE, RUBBER, SEMITRON, G10, MC 501, HDPE, PET, PVC, VESPEL, PP, MONOCAST, THERMO 43',
    array['TNG','C.T Stabil','JWS','ABV','UA Materials','TSA']),
  ('FASTENER', 'BOLT, SHOULDER SCREW, FULL THREAD SUS STEEL',
    array['ACR','Fon Kok','Akas']),
  ('STAINLESS STEEL', 'SUS 303, SUS 304, SUS 316, 316L',
    array['Beye','PHH','Heap Sing Huat','Villgend','Three & Three','TSA','Wong Tool','Long Jing','Dako']),
  ('METAL', 'SUS SHIM PLATE, SUS SPRING STEEL ROD',
    array['CSB Spring']),
  ('METAL', 'CARBIDE, LC110',
    array['QE Tech']),
  ('METAL', 'TITANIUM',
    array['C.T Stabil','ABV','JWS']),
  ('METAL', 'BRASS, COPPER, BRONZE',
    array['G 1 Metal','AMS Light Metal','Lum Choon (Perai)','Heap Sing Huat','PHH','TSA','Three & Three','AL Metal']),
  ('TOOLS', 'DRILL BIT, DRILL BIT LONG SERIES, MACHINE TAP, REAMER, CARBIDE REAMER, CORNER RADIUS ENDMILL/CUTTER, CARBIDE SPOT DRILL, CARBIDE ENDMILL, ENDMILL, BALL NOSE ENDMILL, CHAMFERS, HIGH FEED CUTTING, SHOULDER MILL, INSERT HOLDER',
    array['Butterworth Motorworks','Dura','T&T','Mapal','Maxta','New-tech Metal (NTM)','SY Precision','NW Asia','Mec-Mart','Menschtech','Yomax','Winly Tooling','Wintools Engineering']),
  ('TOOLS', 'SPIRAL POINT TAP, CARBIDE ENDMILL',
    array['Leadtec Tooling','Sunny Score']),
  ('TOOLS', 'NACHI COBALT DRILL, NACHI COBALT LONG SERIES, HAYASAKA MACHINE TAP',
    array['Butterworth Motorworks','Yomax','New-tech Metal (NTM)']),
  ('TOOLS', 'BANDSAW, GRINDING WHEEL, DIAMOND WHEEL',
    array['New-tech Metal (NTM)','QE Tech','SY Precision']),
  ('TOOLS', 'ZERO SETTER, ARBOUR, COLLET',
    array['Mapal','Maxta','Winly Tooling']),
  ('TOOLS', 'REGRIND TAP SERVICE',
    array['Mapal']),
  ('TOOLS', 'COOLANT PUMP',
    array['NTK Industrial']),
  ('TOOLS', 'MALE CONNECTOR, TUBE FITTING, HOSE',
    array['Fit System'])
)
insert into supplier_materials (supplier_id, category, materials, sort_order)
select s.id, g.category, g.materials, ord.n - 1
from groups g
cross join lateral unnest(g.supplier_names) with ordinality as ord(supplier_name, n)
join suppliers s on s.name = ord.supplier_name;

-- Sanity check — paste this after running the file. Expect 50 / 22 / 86:
--   select
--     (select count(*) from suppliers)          as suppliers,
--     (select count(distinct (category, materials)) from supplier_materials) as groups,
--     (select count(*) from supplier_materials) as memberships;
