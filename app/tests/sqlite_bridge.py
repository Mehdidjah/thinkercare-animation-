import json,sqlite3,sys
p=json.load(sys.stdin);c=sqlite3.connect(p['path']);c.row_factory=sqlite3.Row;c.execute('PRAGMA foreign_keys=ON')
try:
 if p['mode']=='init':
  for sql in p['sql']:c.executescript(sql)
  out={}
 elif p['mode']=='batch':
  with c:
   out=[]
   for a in p['statements']:
    r=c.execute(a['sql'],a.get('args',[]));out.append({'meta':{'changes':r.rowcount}})
 else:
  r=c.execute(p['sql'],p.get('args',[]))
  if p['mode']=='all':out={'results':[dict(x) for x in r.fetchall()]}
  elif p['mode']=='first':
   x=r.fetchone();out=dict(x) if x else None
  else:out={'meta':{'changes':r.rowcount}}
  c.commit()
 print(json.dumps({'ok':True,'result':out}))
except Exception as e:
 c.rollback();print(json.dumps({'ok':False,'error':str(e)}))
finally:c.close()
