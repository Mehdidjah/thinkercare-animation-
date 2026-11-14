from pathlib import Path
import sqlite3,json,uuid
root=Path(__file__).resolve().parents[1];db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
for f in sorted((root/'migrations').glob('*.sql')):db.executescript(f.read_text())
n=0
def ok(name,fn):
 global n
 fn();n+=1;print('PASS',name)
def eq(a,b):assert a==b,(a,b)
def rejection(sql,args=(),msg=None):
 try:db.execute(sql,args)
 except sqlite3.IntegrityError as e:
  if msg:assert msg in str(e),str(e)
  return
 raise AssertionError('Expected rejection')
ok('86 official catalogue references',lambda:eq(db.execute('select count(*) from tf_products').fetchone()[0],86))
for table in ['tf_missions','tf_stores','tf_tickets','tf_counts','tf_photos','tf_complaints']:
 ok('Production seed empty '+table,lambda t=table:eq(db.execute('select count(*) from '+t).fetchone()[0],0))
ok('One direction account',lambda:eq(db.execute("select count(*) from tf_users where role='admin'").fetchone()[0],1))
ok('Initial field access restricted',lambda:eq(tuple(db.execute("select role,active,force_change from tf_users where username='animatrice'").fetchone()),('field',1,1)))
for name in ['f1','f2']:
 db.execute('INSERT INTO tf_users(id,username,label,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)',(name,name,name,'field','00','test','2026-11-14'))
db.execute("INSERT INTO tf_stores(id,name,kind,city,address) VALUES('s1','Fixture store','pharmacy','Fixture','Test address')")
db.execute("INSERT INTO tf_devices(id,name) VALUES('d1','Fixture scanner')")
def add(mid,field,start,end,dev=None):
 db.execute('INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,device_id,device_location,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(mid,'s1',field,'2026-11-14',start,end,'["TOUCHE"]',dev,'Test location','f1','2026-11-14T07:00:00Z'))
add('m1','f1','2026-11-14T08:00:00Z','2026-11-14T12:00:00Z','d1')
statement='INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,device_id,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
args=('conflict','s1','f1','2026-11-14','2026-11-14T10:00:00Z','2026-11-14T13:00:00Z','["TOUCHE"]',None,'f1','now')
ok('No overlapping animatrice',lambda:rejection(statement,args,'SCHEDULE_CONFLICT'))
args=('device-conflict','s1','f2','2026-11-14','2026-11-14T10:00:00Z','2026-11-14T13:00:00Z','["TOUCHE"]','d1','f1','now')
ok('No overlapping Dermoscan',lambda:rejection(statement,args,'SCHEDULE_CONFLICT'))
add('m2','f1','2026-11-14T12:00:00Z','2026-11-14T15:00:00Z','d1');ok('Adjacent schedules allowed',lambda:eq(db.execute('select count(*) from tf_missions').fetchone()[0],2))
stock="INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at) VALUES('m1','antiacne',5,'f1','now')"
ok('No stock modification before start',lambda:rejection(stock,msg='REPORT_LOCKED'))
db.execute("UPDATE tf_missions SET status='ongoing',actual_start='2026-11-14T08:02:00Z' WHERE id='m1'")
ok('Only one ongoing mission per animatrice',lambda:rejection("UPDATE tf_missions SET status='ongoing' WHERE id='m2'",msg='UNIQUE'))
db.execute(stock)
line=lambda q:json.dumps([{'product_id':'antiacne','name':'Fixture','brand':'TOUCHE','qty':q,'unit_price':180000}])
ticket="INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total) VALUES(?,'m1','f1','now',?,?)"
db.execute(ticket,('t1',line(3),540000));ok('Ticket is recorded',lambda:eq(db.execute('select count(*) from tf_tickets').fetchone()[0],1))
ok('Cannot oversell counted stock',lambda:rejection(ticket,('t2',line(3),540000),'STOCK_INSUFFICIENT'))
ok('Retry ID cannot duplicate',lambda:rejection(ticket,('t1',line(1),180000)))
db.execute("UPDATE tf_tickets SET status='void',void_reason='Fixture correction' WHERE id='t1'")
db.execute(ticket,('t2',line(5),900000));ok('Void does not consume stock',lambda:eq(db.execute("SELECT sum(total) FROM tf_tickets WHERE status='valid'").fetchone()[0],900000))
db.execute("UPDATE tf_missions SET status='completed',actual_end='2026-11-14T12:01:00Z',report_status='submitted' WHERE id='m1'")
ok('Submitted report locks count',lambda:rejection("UPDATE tf_counts SET closing=0 WHERE mission_id='m1'",msg='REPORT_LOCKED'))
ok('Submitted report locks tickets',lambda:rejection("UPDATE tf_tickets SET status='void' WHERE id='t2'",msg='REPORT_LOCKED'))
db.execute("UPDATE tf_missions SET report_status='changes' WHERE id='m1'");db.execute("UPDATE tf_counts SET closing=0 WHERE mission_id='m1'");ok('Requested corrections unlock counts',lambda:eq(db.execute("select closing from tf_counts where mission_id='m1'").fetchone()[0],0))
ok('Negative inventory blocked',lambda:rejection("UPDATE tf_counts SET opening=-1 WHERE mission_id='m1'"))
# Simulate D1 batch rollback. A stale version guard must fail before any write.
db.commit();version=db.execute("select version from tf_missions where id='m1'").fetchone()[0]
try:
 with db:
  db.execute("INSERT INTO tf_guards(id,ok) VALUES('stale',(SELECT CASE WHEN version=99 THEN 1 ELSE 0 END FROM tf_missions WHERE id='m1'))")
  db.execute("UPDATE tf_counts SET closing=999 WHERE mission_id='m1'")
except sqlite3.IntegrityError:pass
ok('Stale edit rolled back atomically',lambda:eq(db.execute("select closing from tf_counts where mission_id='m1'").fetchone()[0],0))
# Latest stock snapshot query used by the API.
q="""SELECT * FROM (SELECT c.*,m.day,m.actual_end,ROW_NUMBER() OVER(PARTITION BY c.product_id ORDER BY m.actual_end DESC,c.updated_at DESC) AS rn FROM tf_counts c JOIN tf_missions m ON m.id=c.mission_id WHERE m.store_id='s1' AND m.status='completed' AND c.closing IS NOT NULL) WHERE rn=1"""
ok('Dated last observed stock',lambda:eq(db.execute(q).fetchone()['closing'],0))
print('TOTAL',n,'SQL checks; fixtures only in memory')
