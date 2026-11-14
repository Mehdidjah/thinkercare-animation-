from pathlib import Path
import sqlite3,json
root=Path(__file__).resolve().parents[1];db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON')
for p in sorted((root/'migrations').glob('*.sql')):db.executescript(p.read_text())
assert db.execute("SELECT count(*) FROM tf_products WHERE brand='TOUCHE'").fetchone()[0]==66
assert db.execute("SELECT count(*) FROM tf_products WHERE brand='BELNCO'").fetchone()[0]==20
assert db.execute("SELECT count(*) FROM tf_products WHERE name LIKE '%TEST PRODUCT%'").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM tf_products WHERE brand='BELNCO' AND name LIKE 'Tinted Serum%'").fetchone()[0]==3
assert db.execute("SELECT count(*) FROM tf_products WHERE source_url=''").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM tf_products WHERE image_url!=''").fetchone()[0]>=50
field=db.execute("SELECT id FROM tf_users WHERE username='animatrice'").fetchone()[0]
db.execute("INSERT INTO tf_stores(id,name,kind,city,address) VALUES('s','Fixture','pharmacy','Test','Test')")
db.execute("INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,created_by,updated_at) VALUES('m','s',?,'2026-11-14','2026-11-14T07:00:00Z','2026-11-14T15:00:00Z','[\"TOUCHE\"]','ongoing','2026-11-14T07:00:00Z',?,'now')",(field,field))
def sale(key,product,qty):
 lines=json.dumps([{'product_id':product,'qty':qty,'unit_price':100}]);db.execute("INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total) VALUES(?,'m',?,'now',?,?)",(key,field,lines,qty*100))
sale('unrecorded','antiacne',3)
assert db.execute("SELECT count(*) FROM tf_counts WHERE mission_id='m'").fetchone()[0]==0
assert db.execute("SELECT total FROM tf_tickets WHERE id='unrecorded'").fetchone()[0]==300
# Known counts enforce availability, even when uncounted references are allowed.
db.execute("INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at) VALUES('m','total',2,?,'now')",(field,))
sale('known','total',2)
try:sale('over','total',1);raise AssertionError('Oversell accepted')
except sqlite3.IntegrityError as e:assert 'STOCK_INSUFFICIENT' in str(e)
db.execute("UPDATE tf_tickets SET status='void' WHERE id='known'");sale('after-void','total',2)
# Every user acknowledges the current kind separately; a late arrival is a new alert.
admin=db.execute("SELECT id FROM tf_users WHERE username='direction'").fetchone()[0]
db.execute("INSERT INTO tf_alert_ack VALUES(?,'m','missing_start','now')",(admin,))
assert db.execute("SELECT count(*) FROM tf_alert_ack WHERE mission_id='m' AND kind='late_start'").fetchone()[0]==0
# Remembered pharmacy prices do not change the captured historical sale price.
db.execute("INSERT INTO tf_store_prices VALUES('s','antiacne',190000,'now')")
assert db.execute("SELECT json_extract(lines,'$[0].unit_price') FROM tf_tickets WHERE id='unrecorded'").fetchone()[0]==100
assert db.execute("SELECT late_grace_minutes,start_photo_id,end_photo_id FROM tf_missions WHERE id='m'").fetchone()==(15,None,None)
print('PASS: official catalogues, variant identities, unknown stock, stock exhaustion, void correction, alert acknowledgement and price history.')
