-- Keep the original complaint archive; migrate every record into the standalone service.
CREATE TABLE tf_cases(
 id TEXT PRIMARY KEY,mission_id TEXT REFERENCES tf_missions(id),store_id TEXT REFERENCES tf_stores(id),
 store_label TEXT NOT NULL DEFAULT '',author_id TEXT NOT NULL REFERENCES tf_users(id),product_id TEXT REFERENCES tf_products(id),
 kind TEXT NOT NULL CHECK(kind IN ('complaint','request')),reason TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('quality','commercial','tolerance')),
 channel TEXT NOT NULL DEFAULT 'onsite',lot TEXT NOT NULL DEFAULT '',code TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','ongoing','waiting','resolved','closed')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')),doctor_id TEXT REFERENCES tf_users(id),assignee_id TEXT REFERENCES tf_users(id),
 due_day TEXT NOT NULL DEFAULT '',description TEXT NOT NULL,private_note TEXT NOT NULL DEFAULT '',public_note TEXT NOT NULL DEFAULT '',
 consent INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO tf_cases(id,mission_id,store_id,author_id,product_id,kind,reason,category,lot,code,status,priority,doctor_id,assignee_id,description,private_note,public_note,consent,version,created_at,updated_at)
 SELECT c.id,c.mission_id,m.store_id,c.author_id,c.product_id,'complaint',CASE WHEN c.category='tolerance' THEN 'tolerance' ELSE 'other' END,c.category,c.lot,c.code,c.status,c.priority,c.doctor_id,c.doctor_id,c.description,c.private_note,c.public_note,c.consent,c.version,c.created_at,c.updated_at FROM tf_complaints c JOIN tf_missions m ON m.id=c.mission_id;
CREATE INDEX tf_cases_created ON tf_cases(created_at);
CREATE INDEX tf_cases_author ON tf_cases(author_id,created_at);
CREATE TABLE tf_case_events(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES tf_cases(id),user_id TEXT NOT NULL REFERENCES tf_users(id),at TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',clinical INTEGER NOT NULL DEFAULT 0);
ALTER TABLE tf_tickets ADD COLUMN bonus_amount INTEGER NOT NULL DEFAULT 5000 CHECK(bonus_amount>=0);
CREATE TABLE tf_field_notes(
 id TEXT PRIMARY KEY,author_id TEXT NOT NULL REFERENCES tf_users(id),mission_id TEXT REFERENCES tf_missions(id),store_id TEXT REFERENCES tf_stores(id),store_label TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL CHECK(category IN ('shelf','competitor','feedback','availability','opportunity','other')),product_id TEXT REFERENCES tf_products(id),
 brand TEXT NOT NULL DEFAULT '',competitor TEXT NOT NULL DEFAULT '',sentiment TEXT NOT NULL DEFAULT 'neutral' CHECK(sentiment IN ('positive','neutral','negative')),
 description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','seen','actioned')),manager_note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX tf_field_notes_date ON tf_field_notes(created_at);
CREATE TABLE tf_field_photos(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES tf_field_notes(id),user_id TEXT NOT NULL REFERENCES tf_users(id),object_key TEXT UNIQUE NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER tf_field_photo_limit BEFORE INSERT ON tf_field_photos WHEN (SELECT COUNT(*) FROM tf_field_photos WHERE note_id=NEW.note_id)>=5 BEGIN SELECT RAISE(ABORT,'FIELD_PHOTO_LIMIT'); END;
