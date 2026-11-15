"""Narrow first closed deployment; no cloud calls during import."""
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
    if stage not in ['api', 'migrate']:
        raise ValueError('unsupported release stage')
    kind = 'containerApps' if stage == 'api' else 'jobs'
    return ROOT + f'Microsoft.App/{kind}/hhc-line-harness-{stage}'

def render(stage, image, secrets):
    resource_id(stage)
    if not re.fullmatch(r'alive\.azurecr\.io/hhc-line-harness@sha256:[0-9a-f]{64}', image):
        raise ValueError('expected immutable Harness image')
    keys = ['api-database-url', 'channel-secret'] if stage == 'api' else ['migrate-database-url']
    for key in keys:
        if not re.fullmatch(r'https://alive-vault\.vault\.azure\.net/secrets/hhc-line-harness-' + key + r'/[0-9a-f]{32}', secrets.get(key, '')):
            raise ValueError('expected exact versioned secret slot')
    identity = ROOT + 'Microsoft.ManagedIdentity/userAssignedIdentities/hhc-line-harness-' + stage
    env = [{'name': name, 'value': value} for name, value in {
        'HARNESS_ENABLED': 'false', 'AGENT_ENABLED': 'false', 'EMBEDDING_ENABLED': 'false',
        'HARNESS_RUNTIME_GENERATION': '1', 'HOST': '0.0.0.0', 'PORT': '3000',
    }.items()]
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
    if actual['identity']['type'] != 'UserAssigned' or set(actual['identity']['userAssignedIdentities']) != set(expected['identity']['userAssignedIdentities']):
        raise ValueError('runtime identity mismatch')
    # Azure adds read-only defaults. Every declared security/configuration value must survive readback.
    def contains(value, wanted):
        if isinstance(wanted, dict):
            return isinstance(value, dict) and all(k in value and contains(value[k], v) for k, v in wanted.items())
        if isinstance(wanted, list):
            return isinstance(value, list) and len(value) == len(wanted) and all(contains(a, b) for a, b in zip(value, wanted))
        return value == wanted
    if not contains(actual['properties'], expected['properties']):
        raise ValueError('runtime configuration differs from reviewed manifest')

def deploy(stage, image, secrets):
    if az('account', 'show')['id'] != SUBSCRIPTION:
        raise ValueError('wrong subscription')
    manifest = render(stage, image, secrets)
    for app in az('containerapp', 'list', '-g', GROUP):
        if app['name'] == 'hhc-line-harness-api':
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
    command = ['containerapp'] + (['job'] if stage == 'migrate' else [])
    existing = [x for x in az(*command, 'list', '-g', GROUP) if x['name'] == name]
    if existing:
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
            print(json.dumps({'revision': revision, 'image': image, 'privateIngress': True, 'admission': 'disabled'})); return
        time.sleep(5)
    raise ValueError('closed API readiness not verified')

if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: closed-release.py api|migrate IMAGE_DIGEST')
        deploy(sys.argv[1], sys.argv[2], {
            'api-database-url': os.environ['API_DATABASE_SECRET_URI'],
            'migrate-database-url': os.environ['MIGRATE_DATABASE_SECRET_URI'],
            'channel-secret': os.environ['LINE_CHANNEL_SECRET_URI'],
        })
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        sys.exit('Closed release failed: ' + type(error).__name__)
