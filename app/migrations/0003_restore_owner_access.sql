-- Owner-requested access restoration. Passwords are generated outside source control.
-- Password change is required at first login. The field account has no admin rights.
INSERT INTO tf_guards(id,ok) VALUES('1579fbf2-d3d7-4715-9e74-e9a1cc97d2a6',(SELECT CASE WHEN COUNT(*)=1 THEN 1 ELSE 0 END FROM tf_users WHERE id='09d4ed63-862d-4224-8644-12fb416f590f' AND username='direction' AND role='admin'));
UPDATE tf_users SET salt='7b5db79d29c98184db8b6bf18c0773ff',password_hash='e8061f5fded6318111338b2b31d55ec4f2e7ecab747b6fdc609553c22bd30526',active=1,force_change=1 WHERE id='09d4ed63-862d-4224-8644-12fb416f590f' AND username='direction' AND role='admin';
DELETE FROM tf_sessions WHERE user_id='09d4ed63-862d-4224-8644-12fb416f590f';
INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,force_change,created_at) VALUES('dd3ceb82-cf70-46cb-8f77-4838634cf1d1','animatrice','Animatrice - premier accès','field',1,'4404ed07bbeb612bbbf67eb54d625865','688924a1d78b51d785876e61e693c06f255fc8bb641205654c4d4556fa426886',1,'2026-11-14T12:08:01.597186+00:00');
INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES('5aedf2f8-9b24-4822-b5e1-0c31b57a5f46','09d4ed63-862d-4224-8644-12fb416f590f','2026-11-14T12:08:01.597186+00:00','account.access-restored','09d4ed63-862d-4224-8644-12fb416f590f','{"reason":"owner_requested_access","force_change":true}');
INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES('303544a0-2357-4d62-a1c9-bd770197fd76','09d4ed63-862d-4224-8644-12fb416f590f','2026-11-14T12:08:01.597186+00:00','account.created','dd3ceb82-cf70-46cb-8f77-4838634cf1d1','{"role":"field","force_change":true}');
DELETE FROM tf_guards WHERE id='1579fbf2-d3d7-4715-9e74-e9a1cc97d2a6';
