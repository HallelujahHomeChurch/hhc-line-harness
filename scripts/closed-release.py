"""Bounded Harness deployment; admission and webhook ownership stay operator-controlled."""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SUBSCRIPTION = '3765a72c-2c30-492c-8b88-7a26522903f8'
GROUP = 'hhc-line-harness'
ROOT = f'/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/'
ENVIRONMENT = f'/subscriptions/{SUBSCRIPTION}/resourceGroups/alive/providers/Microsoft.App/managedEnvironments/alive-env'

def resource_id(stage):
    if stage not in ['api', 'migrate', 'worker', 'embedding']:
        raise ValueError('unsupported release stage')
    kind = 'containerApps' if stage == 'api' else 'jobs'
    return ROOT + f'Microsoft.App/{kind}/hhc-line-harness-{stage}'

def render(stage, image, secrets, serving=None):
    resource_id(stage)
    if not re.fullmatch(r'alive\.azurecr\.io/hhc-line-harness@sha256:[0-9a-f]{64}', image):
        raise ValueError('expected immutable Harness image')
    if serving is not None:
        if set(serving) - {'EMBEDDING_CLIENT_ID', 'LINE_LIFF_ID', 'GROUP_TURNS_GROUP_IDS'} != {'LINE_CHANNEL_ID', 'LINE_BOT_ID', 'LINE_LOGIN_CHANNEL_ID', 'HARNESS_RUNTIME_GENERATION'} or not all(isinstance(v, str) for v in serving.values()):
            raise ValueError('invalid serving settings')
        if not re.fullmatch(r'U[0-9a-f]{32}', serving['LINE_BOT_ID']) or serving['LINE_CHANNEL_ID'] != serving['LINE_BOT_ID'] or not re.fullmatch(r'[0-9]{1,20}', serving['LINE_LOGIN_CHANNEL_ID']) or not re.fullmatch(r'[1-9][0-9]{0,15}', serving['HARNESS_RUNTIME_GENERATION']):
            raise ValueError('invalid LINE identity')
    if serving is not None and 'GROUP_TURNS_GROUP_IDS' in serving:
        groups = serving['GROUP_TURNS_GROUP_IDS'].split(',') if serving['GROUP_TURNS_GROUP_IDS'] else []
        if len(groups) > 20 or len(groups) != len(set(groups)) or any(not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', g) for g in groups):
            raise ValueError('invalid group turn allowlist')
    if serving is not None and 'LINE_LIFF_ID' in serving and not re.fullmatch(re.escape(serving['LINE_LOGIN_CHANNEL_ID']) + r'-[A-Za-z0-9]{4,32}', serving['LINE_LIFF_ID']):
        raise ValueError('LIFF must belong to the existing Login channel')
    if serving is not None and 'EMBEDDING_CLIENT_ID' in serving and not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', serving['EMBEDDING_CLIENT_ID']):
        raise ValueError('invalid embedding identity')
    if stage == 'embedding' and (serving is None or 'EMBEDDING_CLIENT_ID' not in serving):
        raise ValueError('embedding requires dedicated identity')
    if stage in ['worker', 'embedding'] and serving is None:
        raise ValueError('worker requires serving settings')
    keys = ['api-database-url', 'channel-secret'] if stage == 'api' else ['api-database-url'] if stage == 'embedding' else [stage + '-database-url']
    bindings = {}
    if serving is not None and stage == 'api':
        bindings = {'LINE_API_ACCESS_TOKEN': 'api-line-token', 'REPLY_ENCRYPTION_KEY': 'reply-key',
                    'ASSET_SOURCE_GATE_TOKEN': 'source-gate-token', 'ACCOUNT_HARNESS_PRIVATE_TOKEN': 'account-token',
                    'HARNESS_GATEWAY_PRIVATE_TOKEN': 'gateway-token', 'AUDIT_HARNESS_TOKEN': 'audit-token', 'OPENAI_API_KEY': 'openai-key', 'OPENAI_PROXY_URL': 'openai-proxy'}
    if stage == 'worker':
        bindings = {'LINE_DOWNLOAD_ACCESS_TOKEN': 'download-token'}
    keys += list(bindings.values())
    for key in keys:
        if not re.fullmatch(r'https://alive-vault\.vault\.azure\.net/secrets/hhc-line-harness-' + key + r'/[0-9a-f]{32}', secrets.get(key, '')):
            raise ValueError('expected exact versioned secret slot')
    identity = ROOT + 'Microsoft.ManagedIdentity/userAssignedIdentities/hhc-line-harness-' + stage
    env = [{'name': name, 'value': value} for name, value in {
        'HARNESS_ENABLED': 'false', 'AGENT_ENABLED': 'false', 'EMBEDDING_ENABLED': 'false',
        'HARNESS_RUNTIME_GENERATION': '1', 'HOST': '0.0.0.0', 'PORT': '3000',
    }.items()]
    if serving is not None and stage != 'migrate':
        values = {
            'HARNESS_ENABLED': 'true', 'LINE_CHANNEL_ID': serving['LINE_CHANNEL_ID'],
            'HARNESS_RUNTIME_GENERATION': serving['HARNESS_RUNTIME_GENERATION'],
            'ASSET_API_ORIGIN': 'https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io',
            'ASSET_WORKLOAD_AUDIENCE': 'api://603d78de-1f3e-448f-b716-0a4ffaa58887',
            'HARNESS_QUEUE_URL': 'https://alivestoragebb99ee6e.queue.core.windows.net/hhc-line-harness-wakes',
            'AZURE_CLIENT_ID': serving['EMBEDDING_CLIENT_ID'] if stage == 'embedding' else '3d69ffef-71f7-4743-ad87-184a4aa472a5' if stage == 'api' else '90d03d34-cd52-49dd-a828-c10d91015585',
        }
        if stage == 'api':
            values.update({k: v for k, v in serving.items() if k != 'EMBEDDING_CLIENT_ID'})
            values.update({'LINE_HARNESS_PROFILE': 'helper', 'ADMIN_ORIGIN': 'https://admin.alive.org.tw',
                'ACCOUNT_API_ORIGIN': 'https://account-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io',
                'AUDIT_API_ORIGIN': 'https://audit-log.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io'})
        elif stage == 'worker':
            values['ASSET_UPLOAD_ORIGINS'] = 'https://alivestoragebb99ee6e.blob.core.windows.net'
        if stage in ['api', 'embedding']:
            values.update({'EMBEDDING_ENABLED': 'true', 'EMBEDDING_PROVIDER': 'azure',
                'AZURE_OPENAI_ENDPOINT': 'https://bible-text-embedding-resource.openai.azure.com/openai/v1/',
                'EMBEDDING_MODEL': 'text-embedding-3-small', 'EMBEDDING_RESPONSE_MODEL': 'text-embedding-3-small',
                'EMBEDDING_VERSION': 'azure-text-embedding-3-small-v1', 'EMBEDDING_DIMENSIONS': '1536',
                'EMBEDDING_INPUT_MICROS_PER_MILLION': '20000'})
        if stage == 'api':
            tariff = json.dumps({'inputMicrosPerMillion': 1000000, 'outputMicrosPerMillion': 5000000,
                'cachedInputMicrosPerMillion': 50000, 'cacheWriteMicrosPerMillion': 1250000,
                'cacheWriteLongMicrosPerMillion': 2500000}, separators=(',', ':'))
            values.update({'AGENT_ENABLED': 'true', 'OPENAI_MODEL': 'gpt-6.1-terra',
                'AZURE_OPENAI_DEPLOYMENT': 'hhc-bulletin-ai',
                'OPENAI_TARIFF_JSON': tariff, 'AZURE_OPENAI_TARIFF_JSON': tariff})
        if stage == 'embedding':
            values = {k: v for k, v in values.items() if k.startswith('EMBEDDING_') or k in
                ['HARNESS_RUNTIME_GENERATION', 'LINE_CHANNEL_ID', 'AZURE_CLIENT_ID', 'AZURE_OPENAI_ENDPOINT']}
        env = [entry for entry in env if entry['name'] not in values]
        env += [{'name': name, 'value': value} for name, value in values.items()]
        env += [{'name': name, 'secretRef': key} for name, key in bindings.items()]
    env.append({'name': 'DATABASE_URL', 'secretRef': keys[0]})
    container = {'name': 'harness', 'image': image, 'env': env,
                 'resources': {'cpu': 0.25, 'memory': '0.5Gi'}}
    config = {'registries': [{'server': 'alive.azurecr.io', 'identity': identity}],
              'secrets': [{'name': key, 'keyVaultUrl': secrets[key], 'identity': identity} for key in keys]}
    template = {'containers': [container]}
    properties = {'workloadProfileName': 'Consumption', 'configuration': config, 'template': template}
    if stage == 'api':
        env.append({'name': 'LINE_CHANNEL_SECRET', 'secretRef': 'channel-secret'})
        properties['managedEnvironmentId'] = ENVIRONMENT
        config.update({'activeRevisionsMode': 'Single', 'maxInactiveRevisions': 2,
                       'ingress': {'external': False, 'allowInsecure': False, 'targetPort': 3000,
                                   'transport': 'http', 'traffic': [{'latestRevision': True, 'weight': 100}]}})
        template['scale'] = {'minReplicas': 1, 'maxReplicas': 1}
        container['probes'] = [
            {'type': kind, 'httpGet': {'path': path, 'port': 3000, 'scheme': 'HTTP'},
             'periodSeconds': period, 'timeoutSeconds': 3, 'failureThreshold': count}
            for kind, path, period, count in [('Startup', '/healthz', 5, 30), ('Readiness', '/readyz', 10, 3), ('Liveness', '/healthz', 30, 3)]]
    else:
        properties['environmentId'] = ENVIRONMENT
        config.update({'triggerType': 'Manual', 'replicaTimeout': 300, 'replicaRetryLimit': 0,
                       'manualTriggerConfig': {'parallelism': 1, 'replicaCompletionCount': 1}})
        container['command'] = ['node', 'dist/src/tools/migrate.js']
        if stage == 'worker':
            config.pop('manualTriggerConfig')
            config.update({'triggerType': 'Event', 'replicaTimeout': 660,
                'eventTriggerConfig': {'parallelism': 1, 'replicaCompletionCount': 1,
                    'scale': {'pollingInterval': 10, 'minExecutions': 0, 'maxExecutions': 1,
                        'rules': [{'name': 'harness-wakes', 'type': 'azure-queue', 'identity': identity,
                            'metadata': {'accountName': 'alivestoragebb99ee6e', 'queueName': 'hhc-line-harness-wakes', 'queueLength': '1'}}]}}})
            container['command'] = ['node', 'dist/src/worker.js']
        if stage == 'embedding':
            config.pop('manualTriggerConfig')
            config.update({'triggerType': 'Schedule', 'replicaTimeout': 660,
                'scheduleTriggerConfig': {'cronExpression': '*/15 * * * *', 'parallelism': 1, 'replicaCompletionCount': 1}})
            container['command'] = ['node', 'dist/src/embedding-worker.js']
    resource = {'type': 'Microsoft.App/' + ('containerApps' if stage == 'api' else 'jobs'),
                'apiVersion': '2025-07-01', 'name': 'hhc-line-harness-' + stage,
                'location': 'eastasia', 'identity': {'type': 'UserAssigned', 'userAssignedIdentities': {identity: {}}},
                'properties': properties}
    return {'$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
            'contentVersion': '1.0.0.0', 'resources': [resource]}

def check_preview(preview, stage):
    target = resource_id(stage).lower()
    if preview.get('status') != 'Succeeded' or not isinstance(preview.get('changes'), list):
        raise ValueError('incomplete provider preview')
    seen = set()
    for change in preview['changes']:
        rid = change['resourceId'].lower()
        if rid in seen:
            raise ValueError('duplicate preview resource')
        seen.add(rid)
        allowed = ['Create', 'Modify', 'NoChange'] if rid == target else ['NoChange', 'Ignore']
        if change['changeType'] not in allowed:
            raise ValueError('preview exceeds stage scope')
    if target not in seen:
        raise ValueError('target absent from preview')

def az(*args):
    return json.loads(subprocess.check_output(['az', *args, '--only-show-errors', '-o', 'json']))

def verify(actual, expected):
    # Azure normalizes resource ID casing in identity readback.
    if actual['identity']['type'] != 'UserAssigned' or {key.lower() for key in actual['identity']['userAssignedIdentities']} != {key.lower() for key in expected['identity']['userAssignedIdentities']}:
        raise ValueError('runtime identity mismatch')
    # Azure adds read-only defaults. Every declared security/configuration value must survive readback.
    def contains(value, wanted, path=()):
        if path == ('configuration', 'ingress', 'transport'):
            return isinstance(value, str) and value.lower() == wanted.lower()
        if isinstance(wanted, dict):
            return isinstance(value, dict) and all(k in value and contains(value[k], v, path + (k,)) for k, v in wanted.items())
        if isinstance(wanted, list):
            if not isinstance(value, list) or len(value) != len(wanted):
                return False
            if path == ('template', 'containers', 0, 'probes'):
                # ACA returns probes ordered by type, independently of request order.
                if any(not isinstance(p, dict) or not isinstance(p.get('type'), str) for p in value):
                    return False
                value = sorted(value, key=lambda p: p['type'])
                wanted = sorted(wanted, key=lambda p: p['type'])
            return all(contains(a, b, path + (i,)) for i, (a, b) in enumerate(zip(value, wanted)))
        return value == wanted
    if not contains(actual['properties'], expected['properties']):
        raise ValueError('runtime configuration differs from reviewed manifest')

def deploy(stage, image, secrets, serving=None):
    if az('account', 'show')['id'] != SUBSCRIPTION:
        raise ValueError('wrong subscription')
    manifest = render(stage, image, secrets, serving)
    for app in az('containerapp', 'list', '-g', GROUP):
        if app['name'] == 'hhc-line-harness-api' and (stage == 'migrate' or serving is None):
            entries = app['properties']['template']['containers'][0]['env']
            if {x['name']: x.get('value') for x in entries}.get('HARNESS_ENABLED') != 'false':
                raise ValueError('closed bootstrap cannot migrate an admitted runtime')
            for revision in az('containerapp', 'revision', 'list', '-g', GROUP, '-n', app['name'], '--all'):
                properties = revision['properties']
                if properties.get('active') or properties.get('replicas', 0) > 0:
                    entries = properties['template']['containers'][0]['env']
                    if {x['name']: x.get('value') for x in entries}.get('HARNESS_ENABLED') != 'false':
                        raise ValueError('closed bootstrap cannot migrate an admitted revision')
    expected = manifest['resources'][0]
    name = expected['name']
    command = ['containerapp'] + (['job'] if stage != 'api' else [])
    resources = az(*command, 'list', '-g', GROUP)
    if stage == 'migrate':
        for job in resources:
            if job['name'] in ['hhc-line-harness-worker', 'hhc-line-harness-embedding']:
                entries = job['properties']['template']['containers'][0]['env']
                if {x['name']: x.get('value') for x in entries}.get('HARNESS_ENABLED' if job['name'].endswith('-worker') else 'EMBEDDING_ENABLED') != 'false':
                    raise ValueError('stop and drain the queue worker before migration')
                if any(x['properties']['status'] not in ['Succeeded', 'Failed', 'Stopped'] for x in az('containerapp', 'job', 'execution', 'list', '-g', GROUP, '-n', job['name'])):
                    raise ValueError('queue worker execution still active')
    existing = [x for x in resources if x['name'] == name]
    if existing and (stage == 'migrate' or serving is None):
        container = existing[0]['properties']['template']['containers'][0]
        if {x['name']: x.get('value') for x in container['env']}.get('HARNESS_ENABLED') != 'false':
            raise ValueError('closed bootstrap cannot replace an admitted runtime')
    if stage == 'migrate':
        executions = az(*command, 'execution', 'list', '-g', GROUP, '-n', name) if existing else []
        if any(x['properties']['status'] not in ['Succeeded', 'Failed', 'Stopped'] for x in executions):
            raise ValueError('migration execution still active')
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'runtime.json'
        path.write_text(json.dumps(manifest))
        preview = az('deployment', 'group', 'what-if', '-g', GROUP, '--template-file', str(path), '--result-format', 'FullResourcePayloads', '--no-pretty-print')
        check_preview(preview, stage)
        az('deployment', 'group', 'create', '-g', GROUP, '-n', 'harness-closed-' + stage,
           '--mode', 'Incremental', '--template-file', str(path))
    actual = az(*command, 'show', '-g', GROUP, '-n', name)
    verify(actual, expected)
    if stage in ['worker', 'embedding']:
        print(json.dumps({'job': name, 'image': image, 'trigger': 'own-queue-only' if stage == 'worker' else 'bounded-quarter-hour'})); return
    if stage == 'migrate':
        execution = az(*command, 'start', '-g', GROUP, '-n', name)['name']
        for _ in range(72):
            result = az(*command, 'execution', 'show', '-g', GROUP, '-n', name, '--job-execution-name', execution)
            status = result['properties']['status']
            if status == 'Succeeded':
                print(json.dumps({'migrationExecution': execution, 'status': status, 'image': image})); return
            if status in ['Failed', 'Stopped']:
                raise ValueError('migration did not succeed')
            time.sleep(5)
        raise ValueError('migration timed out; reconcile execution before retry')
    for _ in range(60):
        app = az('containerapp', 'show', '-g', GROUP, '-n', name)
        revision = app['properties']['latestRevisionName']
        result = az('containerapp', 'revision', 'show', '-g', GROUP, '-n', name, '--revision', revision)
        if result['properties']['healthState'] == 'Healthy' and app['properties'].get('latestReadyRevisionName') == revision:
            verify(app, expected)
            print(json.dumps({'revision': revision, 'image': image, 'privateIngress': True, 'runtime': 'configured' if serving is not None else 'disabled', 'databaseAdmission': 'unchanged'})); return
        time.sleep(5)
    raise ValueError('closed API readiness not verified')

if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: closed-release.py api|migrate IMAGE_DIGEST')
        secrets = {
            'api-database-url': os.environ['API_DATABASE_SECRET_URI'],
            'migrate-database-url': os.environ['MIGRATE_DATABASE_SECRET_URI'],
            'channel-secret': os.environ['LINE_CHANNEL_SECRET_URI'],
        }
        serving = None
        if os.environ.get('SERVING') == 'true':
            secrets.update(json.loads(os.environ['RUNTIME_SECRET_URIS']))
            serving = json.loads(os.environ['LINE_RUNTIME_IDENTITIES'])
        deploy(sys.argv[1], sys.argv[2], secrets, serving)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        sys.exit('Closed release failed: ' + type(error).__name__)
