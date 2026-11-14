-- Internal field operations. No client identities or fabricated commercial records.
CREATE TABLE IF NOT EXISTS tf_users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','manager','field','doctor')),active INTEGER NOT NULL DEFAULT 1,salt TEXT NOT NULL,password_hash TEXT NOT NULL,force_change INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tf_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES tf_users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tf_throttle(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tf_stores(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,city TEXT NOT NULL,address TEXT NOT NULL,contact TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS tf_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,location TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS tf_products(id TEXT PRIMARY KEY,brand TEXT NOT NULL CHECK(brand IN ('TOUCHE','BELNCO','NOOM')),sku TEXT NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL DEFAULT 'pièce',price_hint INTEGER NOT NULL DEFAULT 0 CHECK(price_hint>=0),active INTEGER NOT NULL DEFAULT 1,UNIQUE(brand,sku));
CREATE TABLE IF NOT EXISTS tf_missions(id TEXT PRIMARY KEY,store_id TEXT NOT NULL REFERENCES tf_stores(id),field_id TEXT NOT NULL REFERENCES tf_users(id),day TEXT NOT NULL,start_at TEXT NOT NULL,end_at TEXT NOT NULL,brands TEXT NOT NULL,device_id TEXT REFERENCES tf_devices(id),device_location TEXT NOT NULL DEFAULT '',instructions TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','ongoing','completed','cancelled')),actual_start TEXT,actual_end TEXT,cancel_reason TEXT NOT NULL DEFAULT '',report_status TEXT NOT NULL DEFAULT 'draft' CHECK(report_status IN ('draft','submitted','approved','changes')),report_notes TEXT NOT NULL DEFAULT '',review_note TEXT NOT NULL DEFAULT '',no_sales INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(start_at<end_at));
CREATE INDEX IF NOT EXISTS tf_mission_day ON tf_missions(day,field_id);
CREATE UNIQUE INDEX IF NOT EXISTS tf_one_ongoing ON tf_missions(field_id) WHERE status='ongoing';
CREATE TABLE IF NOT EXISTS tf_counts(mission_id TEXT NOT NULL REFERENCES tf_missions(id),product_id TEXT NOT NULL REFERENCES tf_products(id),opening INTEGER NOT NULL CHECK(opening>=0),received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0),other_out INTEGER NOT NULL DEFAULT 0 CHECK(other_out>=0),closing INTEGER CHECK(closing>=0),damaged INTEGER NOT NULL DEFAULT 0 CHECK(damaged>=0),expiring INTEGER NOT NULL DEFAULT 0 CHECK(expiring>=0),expiry TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(mission_id,product_id));
CREATE TABLE IF NOT EXISTS tf_tickets(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES tf_missions(id),user_id TEXT NOT NULL,created_at TEXT NOT NULL,lines TEXT NOT NULL,total INTEGER NOT NULL CHECK(total>=0),status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','void')),void_reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS tf_tickets_mission ON tf_tickets(mission_id,created_at);
CREATE TABLE IF NOT EXISTS tf_photos(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES tf_missions(id),user_id TEXT NOT NULL,created_at TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',mime TEXT NOT NULL,size INTEGER NOT NULL,object_key TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS tf_complaints(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES tf_missions(id),author_id TEXT NOT NULL,product_id TEXT REFERENCES tf_products(id),category TEXT NOT NULL CHECK(category IN ('quality','commercial','tolerance')),lot TEXT NOT NULL DEFAULT '',code TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','ongoing','waiting','resolved','closed')),priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')),doctor_id TEXT REFERENCES tf_users(id),description TEXT NOT NULL,private_note TEXT NOT NULL DEFAULT '',public_note TEXT NOT NULL DEFAULT '',consent INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tf_complaints_time ON tf_complaints(updated_at);
CREATE TABLE IF NOT EXISTS tf_audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,at TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS tf_guards(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE IF NOT EXISTS tf_ops(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS tf_no_overlap_insert BEFORE INSERT ON tf_missions WHEN NEW.status!='cancelled'
BEGIN
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS(SELECT 1 FROM tf_missions m WHERE m.id!=NEW.id AND m.status!='cancelled' AND NEW.start_at<m.end_at AND NEW.end_at>m.start_at AND (m.field_id=NEW.field_id OR (NEW.device_id IS NOT NULL AND m.device_id=NEW.device_id)));
END;
CREATE TRIGGER IF NOT EXISTS tf_no_overlap_update BEFORE UPDATE ON tf_missions WHEN NEW.status!='cancelled'
BEGIN
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS(SELECT 1 FROM tf_missions m WHERE m.id!=NEW.id AND m.status!='cancelled' AND NEW.start_at<m.end_at AND NEW.end_at>m.start_at AND (m.field_id=NEW.field_id OR (NEW.device_id IS NOT NULL AND m.device_id=NEW.device_id)));
END;
CREATE TRIGGER IF NOT EXISTS tf_counts_editable_insert BEFORE INSERT ON tf_counts
BEGIN
 SELECT RAISE(ABORT,'REPORT_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM tf_missions m WHERE m.id=NEW.mission_id AND (m.status='ongoing' OR (m.status='completed' AND m.report_status IN ('draft','changes'))));
END;
CREATE TRIGGER IF NOT EXISTS tf_counts_editable_update BEFORE UPDATE ON tf_counts
BEGIN
 SELECT RAISE(ABORT,'REPORT_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM tf_missions m WHERE m.id=NEW.mission_id AND (m.status='ongoing' OR (m.status='completed' AND m.report_status IN ('draft','changes'))));
END;
CREATE TRIGGER IF NOT EXISTS tf_tickets_editable_insert BEFORE INSERT ON tf_tickets
BEGIN
 SELECT RAISE(ABORT,'REPORT_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM tf_missions m WHERE m.id=NEW.mission_id AND (m.status='ongoing' OR (m.status='completed' AND m.report_status IN ('draft','changes'))));
END;
CREATE TRIGGER IF NOT EXISTS tf_tickets_editable_update BEFORE UPDATE ON tf_tickets
BEGIN
 SELECT RAISE(ABORT,'REPORT_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM tf_missions m WHERE m.id=NEW.mission_id AND (m.status='ongoing' OR (m.status='completed' AND m.report_status IN ('draft','changes'))));
END;
CREATE TRIGGER IF NOT EXISTS tf_ticket_stock BEFORE INSERT ON tf_tickets WHEN NEW.status='valid'
BEGIN
 SELECT RAISE(ABORT,'STOCK_INSUFFICIENT') WHERE EXISTS (
 SELECT 1 FROM json_each(NEW.lines) l WHERE NOT EXISTS (
 SELECT 1 FROM tf_counts s WHERE s.mission_id=NEW.mission_id AND s.product_id=json_extract(l.value,'$.product_id') AND
 s.opening+s.received-s.other_out >= json_extract(l.value,'$.qty') + COALESCE((SELECT SUM(json_extract(x.value,'$.qty')) FROM tf_tickets t,json_each(t.lines) x WHERE t.mission_id=NEW.mission_id AND t.status='valid' AND json_extract(x.value,'$.product_id')=s.product_id),0)));
END;
INSERT OR IGNORE INTO tf_users(id,username,label,role,salt,password_hash,created_at) VALUES('09d4ed63-862d-4224-8644-12fb416f590f','direction','Direction ThinkerCare','admin','2fcf6b0b80f4abac60ea0c37829d6921','6952e239c6ae5f608b7a496354bf447ac43f7c26534391382cb4a0eaaac58594','2026-11-14T00:00:00.000Z');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('antiacne','TOUCHE','antiacne','Sérum Anti-Acné','pièce','180000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('wcgel','TOUCHE','wcgel','Water Complex Gel','pièce','150000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('wccream','TOUCHE','wccream','Water Complex Cream','pièce','150000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('wcrich','TOUCHE','wcrich','Water Complex Rich','pièce','150000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('wcspf','TOUCHE','wcspf','Water Complex Sunscreen SPF 50','pièce','150000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('nia12','TOUCHE','nia12','Niacinamide 12 % Ultra Pure','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('nia10','TOUCHE','nia10','Niacinamide 10 % + Zinc','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('ha35','TOUCHE','ha35','Acide hyaluronique 3,5 % Ultra Pure','pièce','180000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('sensitive','TOUCHE','sensitive','Peaux sensibles · Hyaluronique + Niacinamide','pièce','180000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('total','TOUCHE','total','Total Cleanser hydratant','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('spray','TOUCHE','spray','Spray protecteur SPF 50','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('gelclean','TOUCHE','gelclean','Gel nettoyant purifiant visage','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('vitc','TOUCHE','vitc','Vitamine C 11 % Ultra Pure','pièce','170000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('sal2','TOUCHE','sal2','Acide salicylique 2 % Ultra Pure','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('hcream','TOUCHE','hcream','Crème hydratante visage','pièce','140000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('shpousse','TOUCHE','shpousse','Shampooing Pousse et Croissance','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('conditioner','TOUCHE','conditioner','Après-Shampooing Densité','pièce','170000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('shanti','TOUCHE','shanti','Shampoing Anti-Chute','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('serumhair','TOUCHE','serumhair','Sérum Anti-Chute','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('packpousse','TOUCHE','packpousse','Pack Pousse et Croissance','pack','325000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('packanti','TOUCHE','packanti','Pack Anti-Chute','pack','295000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('shpso','TOUCHE','shpso','Shampoing Anti-Psoriasis','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('serumpso','TOUCHE','serumpso','Sérum Anti-Irritations','pièce','180000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('packpso','TOUCHE','packpso','Routine Psoriasis Control','pack','345000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('packjunior','TOUCHE','packjunior','Routine Psoriasis Control Junior','pack','620000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('bodywash','TOUCHE','bodywash','Gel douche Anti-Imperfections','pièce','175000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('bodypack','TOUCHE','bodypack','Touché Duo Anti-Imperfections','pack','354000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('lotion','TOUCHE','lotion','Lotion tonique glycolique 8 %','pièce','260000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('vitcspf','TOUCHE','vitcspf','Gel Vitamine C 11 % + SPF 30','pièce','245000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('serumspf','TOUCHE','serumspf','Protection solaire effet sérum SPF 50','pièce','295000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('sal10','TOUCHE','sal10','Acide salicylique 10 % (libellé site)','pièce','190000');
INSERT OR IGNORE INTO tf_products(id,brand,sku,name,unit,price_hint) VALUES('patches','TOUCHE','patches','Micro-Dart Pimple Patches','pièce','260000');
