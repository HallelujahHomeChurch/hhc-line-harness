"""Own disposable PostgreSQL container only; no production credentials."""
from pathlib import Path
import os
import secrets
import subprocess
import time

name = 'harness-bootstrap-' + secrets.token_hex(5)
image = 'pgvector/pgvector@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8'
def run(*args, **kw):
    return subprocess.run(list(args), capture_output=True, text=True, **kw)
def sql(query, role='postgres', database='hhc_line_harness'):
    return run('docker','exec','-i',name,'psql','-XAt','-v','ON_ERROR_STOP=1','-U',role,'-d',database,input=query)
try:
    result = run('docker','run','-d','--name',name,'--memory','512m','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-p','127.0.0.1::5432',
                 '-e','POSTGRES_PASSWORD=fixture',image)
    assert result.returncode == 0
    for _ in range(30):
        if run('docker','exec',name,'pg_isready','-U','postgres').returncode == 0: break
        time.sleep(1)
    else: raise AssertionError('fixture startup failed')
    assert sql('CREATE DATABASE hhc_line_harness;', database='postgres').returncode == 0
    script = Path('scripts/bootstrap-database.sql').read_text().replace(
        '\\getenv api_password HARNESS_API_DB_PASSWORD', "\\set api_password 'fixture-api'").replace(
        '\\getenv worker_password HARNESS_WORKER_DB_PASSWORD', "\\set worker_password 'fixture-worker'").replace(
        '\\getenv migrate_password HARNESS_MIGRATE_DB_PASSWORD', "\\set migrate_password 'fixture-migrate'")
    assert sql(script, database='postgres').returncode != 0, 'wrong database must reject bootstrap'
    assert sql(script.replace('COMMIT;', 'SELECT 1/0; COMMIT;')).returncode != 0
    assert sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'hhc_line_harness_%';").stdout.strip() == '0', 'partial bootstrap left roles behind'
    assert sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';").stdout.strip() == '0', 'partial bootstrap left tables behind'
    assert sql(script).returncode == 0, 'bootstrap failed'
    assert sql(script).returncode != 0, 'repeat bootstrap must not rotate passwords'
    # Managed PostgreSQL can reject extension DDL even when IF NOT EXISTS is a no-op.
    assert sql("""CREATE FUNCTION fixture_extension_owner() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_user='hhc_line_harness_migrate' THEN
        RAISE insufficient_privilege USING MESSAGE='fixture_extension_owner';
      END IF; END $$;
      CREATE EVENT TRIGGER fixture_extension_owner ON ddl_command_start
      WHEN TAG IN ('CREATE EXTENSION') EXECUTE FUNCTION fixture_extension_owner();""").returncode == 0
    limits = sql("SELECT rolname||':'||rolconnlimit FROM pg_roles WHERE rolname LIKE 'hhc_line_harness_%' ORDER BY rolname;")
    assert limits.stdout.strip().splitlines() == ['hhc_line_harness_api:16','hhc_line_harness_migrate:1','hhc_line_harness_worker:3']
    address = run('docker','inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',name).stdout.strip()
    for role, password in [('api','fixture-api'),('worker','fixture-worker'),('migrate','fixture-migrate')]:
        login = run('docker','exec','-e','PGPASSWORD='+password,name,'psql','-h',address,'-U','hhc_line_harness_'+role,'-d','hhc_line_harness','-Atc','SELECT current_user;')
        assert login.returncode == 0 and login.stdout.strip() == 'hhc_line_harness_'+role
    denied = run('docker','exec','-e','PGPASSWORD=wrong',name,'psql','-h',address,'-U','hhc_line_harness_api','-d','hhc_line_harness','-Atc','SELECT 1;')
    assert denied.returncode != 0, 'TCP password validation not enforced'
    port = run('docker','inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',name).stdout.strip()
    env = os.environ.copy(); env['DATABASE_URL'] = 'postgres://hhc_line_harness_migrate:fixture-migrate@127.0.0.1:'+port+'/hhc_line_harness'
    for _ in range(2):
        migration = run('node','--experimental-strip-types','src/tools/migrate.ts',env=env)
        assert migration.returncode == 0, 'full migration under restricted owner failed'
    assert sql('SELECT mode FROM runtime_state;', role='hhc_line_harness_api').stdout.strip() == 'closed'
    hold = subprocess.Popen(['docker','exec',name,'psql','-U','hhc_line_harness_migrate','-d','hhc_line_harness','-Atc','SELECT pg_sleep(10);'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(30):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='hhc_line_harness_migrate';").stdout.strip() == '1': break
            time.sleep(.1)
        else: raise AssertionError('connection cap fixture did not start')
        assert sql('SELECT 1;', role='hhc_line_harness_migrate').returncode != 0, 'migration connection cap not enforced'
    finally:
        hold.wait(timeout=15)
    assert sql('CREATE TABLE probe (id serial primary key, value text);', role='hhc_line_harness_migrate').returncode == 0
    for role in ['hhc_line_harness_api','hhc_line_harness_worker']:
        assert sql("INSERT INTO probe(value) VALUES ('synthetic') RETURNING id;", role=role).returncode == 0
        for query in ['CREATE TABLE forbidden(id int);','INSERT INTO schema_migrations VALUES (\'bad\',\'bad\');','ALTER TABLE probe ADD COLUMN forbidden text;']:
            assert sql(query, role=role).returncode != 0, role + ' acquired migration authority'
    assert sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'hhc_line_harness_%' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);").stdout.strip() == '0'
    print('Database bootstrap: rollback/retry, passwords, full migrations, closed mode, connection cap and DDL/history denial passed')
finally:
    run('docker','rm','-f',name)
