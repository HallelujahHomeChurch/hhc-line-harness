#!/usr/bin/env python3
"""Task-owned Docker resources only; synthetic credentials and isolated network."""
import json,secrets,subprocess,sys,time,urllib.request
image=sys.argv[1]
suffix=secrets.token_hex(6)
network='harness-smoke-'+suffix
postgres=network+'-pg';app=network+'-api';extraction=network+'-extract'
pg_image='pgvector/pgvector@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8'

def run(args,**kwargs): return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**kwargs).stdout.strip()
def probe(path):
    with urllib.request.urlopen('http://127.0.0.1:'+port+path,timeout=2) as r:
        assert r.status==200 and json.load(r)=={'ok':True}
phase="network"
try:
    run(['docker','network','create',network])
    run(['docker','run','-d','--name',postgres,'--network',network,'--memory','512m','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_USER=harness','-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=harness_test',pg_image])
    for _ in range(30):
        ready=subprocess.run(['docker','exec',postgres,'pg_isready','-U','harness'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        if ready:break
        time.sleep(1)
    assert ready,'disposable database did not become ready'
    phase='migrations'
    dsn='postgres://harness:fixture@'+postgres+':5432/harness_test'
    run(['docker','run','--rm','--network',network,'-e','DATABASE_URL='+dsn,image,'node','dist/src/tools/migrate.js'])
    run(['docker','run','--rm','--network',network,'-e','DATABASE_URL='+dsn,image,'node','dist/src/tools/migrate.js'])
    phase='api-start'
    run(['docker','run','-d','--name',app,'--network',network,'--read-only','--tmpfs','/tmp:rw,nosuid,size=64m','-p','127.0.0.1::3000','-e','DATABASE_URL='+dsn,'-e','LINE_CHANNEL_SECRET=synthetic-smoke','-e','HARNESS_ENABLED=false',image])
    user=run(['docker','inspect','--format','{{.Config.User}}',app]);assert user not in ('','root','0','0:0')
    port=run(['docker','inspect','--format','{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}',app])
    phase='api-probes'
    for _ in range(30):
        try:probe('/healthz');probe('/readyz');break
        except (OSError,AssertionError):time.sleep(1)
    else:raise AssertionError('application did not become ready')
    # The copied test exists only in this disposable container, not in the artifact.
    phase='restricted-extraction'
    run(['docker','create','--name',extraction,'--network','none','--tmpfs','/tmp:rw,nosuid,size=64m',image,'node','--test','/app/dist/tests/extraction.test.js'])
    run(['docker','cp','dist/tests',extraction+':/app/dist/tests'])
    run(['docker','start','-a',extraction])
    assert run(['docker','inspect','--format','{{.State.ExitCode}}',extraction])=='0'
    phase='shutdown'
    run(['docker','stop','--time','10',app])
    assert run(['docker','inspect','--format','{{.State.ExitCode}}',app])=='0'
    print('Linux nonroot/read-only startup, migrations, probes, restricted extraction and shutdown passed')
except Exception as error:
    print('Local image smoke failed at '+phase+' ('+type(error).__name__+'); no external endpoint was contacted',file=sys.stderr)
    if isinstance(error,subprocess.CalledProcessError):print((error.stderr or '')[-1500:],file=sys.stderr)
    if phase=='restricted-extraction':
        result=subprocess.run(['docker','logs',extraction],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        print(result.stdout[-5000:],file=sys.stderr)
    raise SystemExit(1)
finally:
    for name in (extraction,app,postgres):subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
